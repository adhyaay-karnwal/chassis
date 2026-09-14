// SPDX-License-Identifier: Apache-2.0

import { SerialPort } from "serialport";
import { cleanText } from "./ansi.js";

/** Max number of buffered lines retained per tracked port (ring buffer cap). */
const MAX_BUFFER_LINES = 5000;

/** Idle timeout: a tracked port with no activity (no read/write/data) for
 * this long is automatically closed and untracked, so long-running MCP
 * sessions don't leak open file handles / serial device locks forever. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface TrackedPort {
  path: string;
  baudRate: number;
  port: SerialPort;
  /** Ring buffer of raw (pre-clean) text chunks received so far. */
  buffer: string[];
  totalBytesBuffered: number;
  /** Index into `buffer` up to which `serial_read_history(only_new)` has already returned. */
  readCursor: number;
  openedAt: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastError: string | null;
}

const trackedPorts = new Map<string, TrackedPort>();

function touch(tracked: TrackedPort, manager: PortManager) {
  tracked.lastActivityAt = Date.now();
  if (tracked.idleTimer) clearTimeout(tracked.idleTimer);
  tracked.idleTimer = setTimeout(() => {
    manager.closePort(tracked.path).catch(() => {
      /* best-effort cleanup */
    });
  }, IDLE_TIMEOUT_MS);
  // Don't let the idle timer keep the process alive on its own.
  tracked.idleTimer.unref?.();
}

function pushToBuffer(tracked: TrackedPort, chunk: string) {
  tracked.buffer.push(chunk);
  tracked.totalBytesBuffered += chunk.length;
  while (tracked.buffer.length > MAX_BUFFER_LINES) {
    const removed = tracked.buffer.shift();
    tracked.totalBytesBuffered -= removed?.length ?? 0;
    if (tracked.readCursor > 0) tracked.readCursor--;
  }
}

export class PortManager {
  /** Open (or return the already-open) connection for a port at a given baud rate. */
  async open(portPath: string, baudRate = 115200): Promise<TrackedPort> {
    const existing = trackedPorts.get(portPath);
    if (existing) {
      touch(existing, this);
      return existing;
    }

    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });

    await new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const tracked: TrackedPort = {
      path: portPath,
      baudRate,
      port,
      buffer: [],
      totalBytesBuffered: 0,
      readCursor: 0,
      openedAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
      lastError: null,
    };

    port.on("data", (data: Buffer) => {
      pushToBuffer(tracked, data.toString("utf8"));
      touch(tracked, this);
    });

    port.on("error", (err: Error) => {
      tracked.lastError = err.message;
    });

    port.on("close", () => {
      if (tracked.idleTimer) clearTimeout(tracked.idleTimer);
      trackedPorts.delete(portPath);
    });

    tracked.idleTimer = setTimeout(() => {
      this.closePort(portPath).catch(() => {});
    }, IDLE_TIMEOUT_MS);
    tracked.idleTimer.unref?.();

    trackedPorts.set(portPath, tracked);
    return tracked;
  }

  get(portPath: string): TrackedPort | undefined {
    return trackedPorts.get(portPath);
  }

  list(): TrackedPort[] {
    return [...trackedPorts.values()];
  }

  async writeLine(portPath: string, line: string): Promise<void> {
    const tracked = trackedPorts.get(portPath);
    if (!tracked) throw new Error(`Port ${portPath} is not open`);
    await new Promise<void>((resolve, reject) => {
      tracked.port.write(`${line}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    touch(tracked, this);
  }

  /** Read the retained buffer for a port, optionally draining only-new content. */
  readBuffer(portPath: string, onlyNew: boolean, lastNLines?: number): string {
    const tracked = trackedPorts.get(portPath);
    if (!tracked) throw new Error(`Port ${portPath} is not open`);

    const chunks = onlyNew ? tracked.buffer.slice(tracked.readCursor) : tracked.buffer;
    let text = cleanText(chunks.join(""));

    if (onlyNew) tracked.readCursor = tracked.buffer.length;

    if (lastNLines && lastNLines > 0) {
      const lines = text.split("\n");
      text = lines.slice(Math.max(0, lines.length - lastNLines)).join("\n");
    }

    return text;
  }

  async closePort(portPath: string): Promise<boolean> {
    const tracked = trackedPorts.get(portPath);
    if (!tracked) return false;
    if (tracked.idleTimer) clearTimeout(tracked.idleTimer);
    trackedPorts.delete(portPath);
    if (tracked.port.isOpen) {
      await new Promise<void>((resolve) => {
        tracked.port.close(() => resolve());
      });
    }
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...trackedPorts.keys()].map((p) => this.closePort(p)));
  }
}

export const portManager = new PortManager();
