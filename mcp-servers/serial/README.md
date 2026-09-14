# chassis-mcp-serial

A standalone [MCP](https://modelcontextprotocol.io) server that exposes serial-port
tools for firmware/embedded debugging: enumerate ports, monitor UART/serial output,
send interactive commands to a running device, and read back buffered history —
the kind of serial-monitor workflow embedded engineers need when flashing and
bringing up microcontrollers.

It's a plain stdio MCP server with no chassis-specific code in it. It works with
[chassis](../../README.md), and equally with any other MCP-compatible client
(Claude Code, Cursor, etc.).

## What it does

Five tools, backed by in-memory per-port state held for the life of the server process:

| Tool | Purpose |
| --- | --- |
| `list_serial_ports` | Enumerate serial ports visible to the host OS (no args). |
| `serial_monitor` | Open (or reuse) a connection and capture output, either for a fixed time window or until a `stop_string` appears. |
| `serial_send_command` | Send a line to a port (auto-connects if needed) and return the response captured within a short wait window. |
| `serial_read_history` | Non-blocking read of already-buffered output for a tracked port (or list all tracked ports if no `port` given). |
| `close_serial_port` | Explicitly close and untrack a port, e.g. to free the device for a flashing tool. |

See the tool descriptions in [`src/index.ts`](src/index.ts) for full argument
details and defaults — they're written to be read by the calling agent, so
they're the source of truth.

### Connection lifecycle

Opening a port (via `serial_monitor` or `serial_send_command`) leaves it open and
tracked in a `Map<port, TrackedPort>` in server memory, so later calls against the
same port path reuse the connection instead of reopening it. Each tracked port
keeps a ring-buffered capture history (capped at the last ~5000 received chunks)
so `serial_read_history` can return recent output without a new read.

Ports are **not** kept open forever: any port idle (no reads/writes/incoming data)
for 10 minutes is automatically closed and untracked, so a long MCP session won't
leak open file handles or hold a device locked indefinitely. Call
`close_serial_port` explicitly whenever you need a device released sooner — most
importantly, before running a flashing tool that needs exclusive access to the
port.

### Text handling

Captured output has line endings normalized to `\n` and ANSI escape/color codes
stripped by default (see [`src/ansi.ts`](src/ansi.ts)), since most agents want
clean, readable text rather than raw terminal control sequences.

## Install & build

Uses `npm` (no monorepo tooling — this is a fully self-contained package).

```bash
cd mcp-servers/serial
npm install
npm run build       # tsc -> dist/
```

Useful scripts:

- `npm run typecheck` — `tsc --noEmit`, no build output.
- `npm run smoke-test` — spawns the built server, performs the MCP `initialize` +
  `tools/list` handshake over stdio, and calls `list_serial_ports` for real. Does
  not require any serial hardware attached (it just proves the server wires up
  correctly and enumeration doesn't throw).

## Wiring it into an MCP client

Add to your workspace's `.mcp.json` (Claude Code-compatible format, also read by
chassis) or `~/.chassis/mcp.json`:

```json
{
  "mcpServers": {
    "serial": {
      "command": "node",
      "args": ["/absolute/path/to/chassis/mcp-servers/serial/dist/index.js"]
    }
  }
}
```

Use an absolute path to `dist/index.js` — it must exist, i.e. you must have run
`npm run build` first.

## What's tested vs. not

- `npm install` succeeds, `tsc --noEmit` and the `build` script both compile
  clean with no type errors.
- The compiled server starts and correctly completes an MCP `initialize` +
  `tools/list` handshake over stdio, returning all 5 tools with valid input
  schemas (verified by `scripts/smoke-test.mjs`).
- `list_serial_ports` is exercised for real via the smoke test (no hardware
  required to enumerate; it just returns whatever the host OS reports).
- **Not tested here** (no serial hardware attached in this environment): actual
  device I/O for `serial_monitor`, `serial_send_command`, `serial_read_history`,
  and `close_serial_port` against a real board. These need to be verified against
  real hardware (e.g. an ESP32/Arduino/etc. on `/dev/ttyUSB0` or similar) by
  whoever picks this up next.

## License

Apache-2.0, consistent with the rest of the chassis repo. See the root
[`LICENSE`](../../LICENSE).
