```
 ⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⠀⠀⢰⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⣠⣶⣿⣿⣷⣶⡶⣶⣶⣆⠀⠀⠀⣴⣶⣶⠆
 ⠀⠀⠀⠉⢹⣿⣿⠉⠉⠀⠘⢿⣿⣧⣀⣾⣿⡿⠃⠀             Tiny, open, embeddable, native coding agent.
 ⠀⠀⠀⠀⣼⣿⡏⠀⠀⠀⠀⠀⠻⣿⣿⣿⠟⠀⠀⠀
 ⠀⠀⠀⢀⣿⣿⠃⠀⠀⠀⠀⢠⣦⠘⢿⣿⣷⡀⠀⠀             git clone https://github.com/adhyaay-karnwal/chassis && cd chassis && zig build
 ⠀⠀⠀⣸⣿⡟⠀⠀⠀⠀⣰⣿⣿⠗⠀⠻⣿⣿⣄⠀
 ⠀⠀⠀⣿⣿⠇⠀⠀⠀⠾⠿⠿⠋⠀⠀⠀⠘⠿⠿⠦             ⚠ Status: Experimental. Use at your own risk.
  ⠀⣸⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⣿⣿⣿⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
```

chassis is a coding agent CLI written in Zig: a 6.17 MiB native binary that is open source (Apache-2.0), model-agnostic, and embeddable as a harness in larger systems. Its interface stays closer to a Unix shell than an IDE in the terminal.

## Install

chassis does not yet have a hosted install script or CDN. Build from source
(see [Build from source](#build-from-source) below); a proper install script
is future work.

```bash
git clone https://github.com/adhyaay-karnwal/chassis && cd chassis && zig build
```

## Get started

Sign in with one of:

- `chassis login`: Vercel AI Gateway
- `chassis login codex`: ChatGPT subscription (OpenAI Codex OAuth)
- `chassis login grok`: Grok subscription (xAI OAuth)
- `chassis setup`: AI Gateway API key

Then start the interactive shell from a project:

```bash
cd your_project
chassis
```

Or make a one-shot request:

```bash
chassis ask "explain the changes in this repository"
```

Inside the shell, run `/help` to browse interactive commands.

## Embed chassis

chassis builds as a native binary or WebAssembly. Applications embedding chassis can provide network transport, session storage, configuration, permission handling, and terminal I/O.

| Surface | Use |
| --- | --- |
| `chassis acp` | Connect the native agent to editors and other Agent Client Protocol clients. |
| `createChassisAgent()` | Embed the agent core in a JavaScript host with `chassis-core.wasm`. |
| `createChassisTerminal()` | Embed the interactive terminal with `chassis-term.wasm`. |

The WebAssembly SDK is experimental. See the [WebAssembly SDK](sdk/README.md).

The SDK is published to npm as [libchassis](https://www.npmjs.com/package/libchassis). For runnable Node.js, browser, Next.js, and Nuxt applications, see the [libchassis examples](examples/README.md).

## Extend chassis

- Skills: reusable instructions the agent loads when invoked
- MCP: connect external tools and servers
- Subagents: delegate independent work

## Embedded / hardware firmware work

chassis started as a general-purpose fork, but the goal is to build it out into an open alternative to closed embedded/firmware coding agents (e.g. Embedder) — grounded, local-first, and usable from any MCP-compatible client, not locked to one CLI.

Shipped so far:

| Capability | How |
| --- | --- |
| Serial monitor / send commands / read history | [`mcp-servers/serial`](mcp-servers/serial) — MCP server wrapping `serialport` |
| Local, offline-by-default datasheet grounding with page citations | [`mcp-servers/datasheet`](mcp-servers/datasheet) — MCP server, lexical (BM25) search out of the box, optional embeddings if you configure an API key. Datasheets never leave your machine unless you opt in. |
| Build / flash | Already covered by chassis's built-in `shell` tool — run `west build`, `idf.py flash`, `make`, or whatever your project uses, no special-cased tool needed |
| Firmware engineering workflow standards | [`skills/embedded-firmware`](skills/embedded-firmware) — codebase archaeology, datasheet-grounded register values, RTOS discipline, hardware verify loop |

To enable, add both servers to `.mcp.json` in your firmware project (see each server's README for the exact snippet and build steps), and the `embedded-firmware` skill is auto-discovered from the workspace `skills/` directory once you copy or symlink it into your project.

Roadmap (not yet built): GDB/debug-probe integration, logic analyzer / oscilloscope capture, schematic ingestion (Altium/KiCad/Eagle), SIL/HIL test orchestration. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

chassis does not yet have a hosted documentation site. Run `/help` inside an
interactive session, or `chassis <command> --help`, for CLI and slash command
references. See `AGENTS.md` and `CONTRIBUTING.md` for architecture and
contribution details.

## Build from source

Building chassis requires [Zig 0.16.0+](https://ziglang.org/download/):

```bash
git clone https://github.com/adhyaay-karnwal/chassis.git
cd chassis
zig build -Doptimize=ReleaseSafe
./zig-out/bin/chassis
```

Run the test suite with `zig build test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidelines.

## License

[Apache-2.0](LICENSE)

Third-party licenses and attributions are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

chassis is a fork of [vercel-labs/fx](https://github.com/vercel-labs/fx), generalized away from Vercel AI Gateway as a default and extended toward embedded/firmware use cases. All credit for the original agent core, TUI, and MCP/skills/subagent infrastructure goes to the fx authors.

Interface sounds by [cuelume](https://github.com/Danilaa1/cuelume).
