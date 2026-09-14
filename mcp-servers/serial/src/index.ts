#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SerialPort } from "serialport";
import { z } from "zod";
import { portManager, type TrackedPort } from "./portManager.js";
import { cleanText } from "./ansi.js";

const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_CAPTURE_TIMEOUT_MS = 3000;
const DEFAULT_STOP_STRING_TIMEOUT_MS = 30000;
const DEFAULT_COMMAND_RESPONSE_WAIT_MS = 1000;

const server = new McpServer({
  name: "chassis-mcp-serial",
  version: "0.1.0",
});

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// list_serial_ports
// ---------------------------------------------------------------------------
server.registerTool(
  "list_serial_ports",
  {
    title: "List serial ports",
    description:
      "Enumerate serial ports currently visible to the host OS (e.g. /dev/ttyUSB0, /dev/cu.usbmodem*, COM3). " +
      "Use this first to discover which port a microcontroller or debug adapter is attached to before calling " +
      "serial_monitor or serial_send_command. Returns, for each port: path, manufacturer, vendorId/productId " +
      "(USB VID/PID, useful for identifying the exact board), and serialNumber, where the OS/driver makes them " +
      "available (fields may be undefined on some platforms/adapters). Takes no arguments. An empty result means " +
      "no serial devices are currently attached/enumerable, not an error.",
    inputSchema: {},
  },
  async () => {
    try {
      const ports = await SerialPort.list();
      const result = ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        vendorId: p.vendorId,
        productId: p.productId,
        serialNumber: p.serialNumber,
        pnpId: p.pnpId,
      }));
      return textResult(JSON.stringify(result, null, 2));
    } catch (err) {
      return errorResult(`Failed to list serial ports: ${describeError(err)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// serial_monitor
// ---------------------------------------------------------------------------
server.registerTool(
  "serial_monitor",
  {
    title: "Monitor a serial port",
    description:
      "Open a serial connection (or reuse one already opened by a previous call for this same port) and capture " +
      "output for a period of time. Two capture modes:\n" +
      "1. If `stop_string` is given, capture stops as soon as that exact substring appears in the received output " +
      "(or after `timeout_ms`/30000ms, whichever comes first) — use this to wait for a specific boot banner, " +
      "'READY' prompt, or log line.\n" +
      "2. If `stop_string` is omitted, capture runs for a fixed window of `timeout_ms` (default 3000ms) and returns " +
      "whatever arrived.\n" +
      "If `startup_commands` are given, each is written as a line (newline-terminated) to the port immediately " +
      "after opening, before capture begins — useful for e.g. pressing enter to wake a CLI or sending a reset " +
      "command. The connection is left open and tracked after this call returns (it is NOT closed), so subsequent " +
      "serial_send_command / serial_read_history calls against the same `port` reuse it without reconnecting. " +
      "Idle connections are auto-closed after 10 minutes of inactivity; call close_serial_port to release a port " +
      "explicitly (e.g. before flashing new firmware, which typically needs exclusive access to the device). " +
      "Returned text has line endings normalized to \\n and ANSI escape/color codes stripped for readability.",
    inputSchema: {
      port: z.string().describe("Serial port path, e.g. /dev/ttyUSB0, /dev/cu.usbmodem14201, or COM3"),
      baud_rate: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Baud rate to open the connection at if not already open. Default ${DEFAULT_BAUD_RATE}.`),
      stop_string: z
        .string()
        .optional()
        .describe("Substring to watch for; capture stops as soon as it appears in the accumulated output."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Max capture duration in ms. Default ${DEFAULT_CAPTURE_TIMEOUT_MS}ms with no stop_string, or ` +
            `${DEFAULT_STOP_STRING_TIMEOUT_MS}ms as the safety timeout when stop_string is given.`,
        ),
      startup_commands: z
        .array(z.string())
        .optional()
        .describe("Lines to send to the port immediately after opening, before capture begins."),
    },
  },
  async ({ port: portPath, baud_rate, stop_string, timeout_ms, startup_commands }) => {
    try {
      const tracked = await portManager.open(portPath, baud_rate ?? DEFAULT_BAUD_RATE);

      if (startup_commands && startup_commands.length > 0) {
        for (const cmd of startup_commands) {
          await portManager.writeLine(portPath, cmd);
        }
      }

      const captureStartIndex = tracked.buffer.length;
      const effectiveTimeout =
        timeout_ms ?? (stop_string ? DEFAULT_STOP_STRING_TIMEOUT_MS : DEFAULT_CAPTURE_TIMEOUT_MS);

      const captured = await captureUntil(tracked, captureStartIndex, stop_string, effectiveTimeout);
      // Keep the read cursor in sync so a later serial_read_history(only_new) doesn't re-return this.
      tracked.readCursor = tracked.buffer.length;

      const stoppedOnMatch = stop_string ? captured.includes(stop_string) : undefined;
      const header =
        stop_string !== undefined
          ? `[stop_string ${stoppedOnMatch ? "matched" : "NOT matched (timed out)"} after up to ${effectiveTimeout}ms]\n`
          : `[captured for ${effectiveTimeout}ms]\n`;

      return textResult(header + cleanText(captured));
    } catch (err) {
      return errorResult(`serial_monitor failed for ${portPath}: ${describeError(err)}`);
    }
  },
);

function captureUntil(
  tracked: TrackedPort,
  startIndex: number,
  stopString: string | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    const check = () => {
      const text = tracked.buffer.slice(startIndex).join("");
      if (stopString && text.includes(stopString)) {
        cleanup();
        resolve(text);
      }
    };

    const onData = () => check();
    tracked.port.on("data", onData);

    const timer = setTimeout(() => {
      cleanup();
      resolve(tracked.buffer.slice(startIndex).join(""));
    }, timeoutMs);
    timer.unref?.();

    function cleanup() {
      clearTimeout(timer);
      tracked.port.off("data", onData);
    }

    // In case data already arrived (e.g. from startup_commands) before we attached the listener.
    check();
  });
}

// ---------------------------------------------------------------------------
// serial_send_command
// ---------------------------------------------------------------------------
server.registerTool(
  "serial_send_command",
  {
    title: "Send a command to a serial port",
    description:
      "Send a command string to a serial device as a single line (a trailing '\\n' is appended automatically — " +
      "do not include your own newline). Auto-connects to `port` at `baud_rate` (or the baud rate it was already " +
      "opened at, or 115200 by default) if it isn't already tracked/open. After sending, waits " +
      `${DEFAULT_COMMAND_RESPONSE_WAIT_MS}ms (configurable via \`wait_ms\`) for the device to respond, then ` +
      "returns whatever output arrived during that window (ANSI-stripped, line endings normalized). The " +
      "connection is left open/tracked for subsequent calls.",
    inputSchema: {
      port: z.string().describe("Serial port path, e.g. /dev/ttyUSB0 or COM3"),
      command: z.string().describe("Command text to send as a line (newline appended automatically)."),
      baud_rate: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Baud rate to connect at if not already open. Default ${DEFAULT_BAUD_RATE}.`),
      wait_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How long to wait for a response after sending, in ms. Default ${DEFAULT_COMMAND_RESPONSE_WAIT_MS}.`),
    },
  },
  async ({ port: portPath, command, baud_rate, wait_ms }) => {
    try {
      const tracked = await portManager.open(portPath, baud_rate ?? DEFAULT_BAUD_RATE);
      const startIndex = tracked.buffer.length;
      await portManager.writeLine(portPath, command);

      const waitMs = wait_ms ?? DEFAULT_COMMAND_RESPONSE_WAIT_MS;
      const response = await captureUntil(tracked, startIndex, undefined, waitMs);
      tracked.readCursor = tracked.buffer.length;

      return textResult(cleanText(response) || "[no response received within wait window]");
    } catch (err) {
      return errorResult(`serial_send_command failed for ${portPath}: ${describeError(err)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// serial_read_history
// ---------------------------------------------------------------------------
server.registerTool(
  "serial_read_history",
  {
    title: "Read buffered serial output",
    description:
      "Non-blocking read of output already captured from a tracked (currently open) serial port — does not open " +
      "a new connection, send anything, or wait. If `port` is omitted, instead returns a JSON list of all " +
      "currently tracked ports with their status (baud rate, opened/last-activity time, buffered byte count) — " +
      "use this to see what's currently connected. If `port` is given: with `only_new` true, returns only output " +
      "received since the last serial_read_history/serial_monitor/serial_send_command call for that port and " +
      "advances the read cursor (drain-and-return, good for polling); with `only_new` false/omitted, returns the " +
      "full retained buffer without consuming it (the buffer is a ring buffer capped at the last ~5000 chunks, so " +
      "very old output on a long-running session may have been evicted). `last_n_lines` optionally caps the " +
      "returned text to the last N lines.",
    inputSchema: {
      port: z
        .string()
        .optional()
        .describe("Serial port path. Omit to list all currently tracked ports and their status instead."),
      only_new: z
        .boolean()
        .optional()
        .describe("If true, return and consume only output received since the last read call. Default false."),
      last_n_lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap the returned text to the last N lines."),
    },
  },
  async ({ port: portPath, only_new, last_n_lines }) => {
    try {
      if (!portPath) {
        const ports = portManager.list().map((t) => ({
          port: t.path,
          baud_rate: t.baudRate,
          opened_at: new Date(t.openedAt).toISOString(),
          last_activity_at: new Date(t.lastActivityAt).toISOString(),
          buffered_bytes: t.totalBytesBuffered,
          last_error: t.lastError,
        }));
        return textResult(JSON.stringify(ports, null, 2));
      }

      const text = portManager.readBuffer(portPath, only_new ?? false, last_n_lines);
      return textResult(text || "[no buffered output]");
    } catch (err) {
      return errorResult(`serial_read_history failed for ${portPath}: ${describeError(err)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// close_serial_port
// ---------------------------------------------------------------------------
server.registerTool(
  "close_serial_port",
  {
    title: "Close a tracked serial port",
    description:
      "Explicitly close and stop tracking a serial connection previously opened by serial_monitor or " +
      "serial_send_command. Use this for cleanup, or to release a device so another tool (e.g. a firmware " +
      "flashing utility) can open it exclusively. It is not an error to close a port that isn't currently tracked " +
      "— the tool reports whether anything was actually closed. Open ports are also auto-closed after 10 minutes " +
      "of inactivity, so explicit closing is only required when you need the device freed up sooner.",
    inputSchema: {
      port: z.string().describe("Serial port path to close, e.g. /dev/ttyUSB0 or COM3"),
    },
  },
  async ({ port: portPath }) => {
    try {
      const wasOpen = await portManager.closePort(portPath);
      return textResult(wasOpen ? `Closed ${portPath}.` : `${portPath} was not open/tracked; nothing to do.`);
    } catch (err) {
      return errorResult(`close_serial_port failed for ${portPath}: ${describeError(err)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function shutdown() {
  await portManager.closeAll();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal error starting chassis-mcp-serial:", err);
  process.exit(1);
});
