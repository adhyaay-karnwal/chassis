---
name: embedded-firmware
description: Workflow and standards for firmware/embedded systems engineering tasks - driver implementation, peripheral bring-up, RTOS work, and debugging on real hardware. Use when working in a firmware, MCU, or hardware-adjacent codebase (C/C++/Rust targeting a microcontroller, RTOS project, HAL/BSP code, or any repo with a `.elf`/linker script/vendor SDK), or when the user mentions a chip, board, peripheral, datasheet, serial monitor, or flashing hardware.
---

# Embedded Firmware Engineering

You are doing firmware engineering: code that runs on real, resource-constrained silicon. Hardware constraints are not optional context — they are the spec. A change that compiles but violates a timing budget, overflows a fixed buffer, or writes a wrong register value is not a working change.

## Ground truth over assumption

Never guess a register address, bit field, timing constant, pin mapping, or initialization sequence. If a `datasheet` MCP tool is available (`search_datasheets`, `ingest_document`, `list_documents`), use it before writing any hardware-dependent constant:

1. Check `list_documents` for what's already indexed for this project.
2. If the relevant datasheet/reference manual/errata isn't indexed yet, ask the user for the file and `ingest_document` it before proceeding — don't write speculative register values while waiting.
3. Cite what you find: `search_datasheets` returns filename + page number. Reference that in comments only when the value itself would otherwise be non-obvious (see repo comment conventions), and reference it in your own response to the user so they can verify.
4. If no datasheet tool is configured and the user hasn't pasted relevant excerpts, say so explicitly rather than inventing plausible-looking values. A wrong register write can be worse than no write.

SVD files, vendor HAL headers, and existing driver code in the repo are also ground truth — prefer a `#define`/HAL constant that already exists in the codebase over deriving one yourself.

## Codebase archaeology before touching hardware-facing code

Before modifying a driver, ISR, or peripheral init sequence:

- Find every caller of the function/struct you're changing (`grep_files`/equivalent). Read at least two call sites to learn the actual contract: units (raw counts vs. scaled), timing assumptions, and error handling expectations.
- Identify what state the code assumes on entry (clock configured, peripheral powered, prior init sequence run) and what it leaves on exit.
- Match existing conventions exactly: register access patterns, error-handling style, naming, HAL vs. direct register access. Don't introduce a second style for the same class of problem.

## Resource scarcity mindset

RAM, flash, and CPU cycles are finite. Prefer static allocation over dynamic. Question every heap allocation and every dynamically-sized structure. Align buffers to hardware word boundaries when it matters for DMA or peripheral access. Don't add abstraction layers that cost cycles or flash for a hypothetical future need.

## RTOS discipline

When touching RTOS code (FreeRTOS, Zephyr, or similar): respect existing task priorities, protect shared state with the project's existing synchronization primitives rather than inventing new ones, watch for priority inversion, and keep ISRs short — defer real work to a task/deferred-work context unless the existing code already does otherwise for a documented reason.

## The verify loop

A firmware change is not done when it compiles. If build/flash tooling is available via `shell` (e.g. `west build`, `idf.py build`, `make`, vendor CLI, or a project-specific script — check the repo for what it actually uses, don't assume), and the change is testable on attached hardware:

1. Build.
2. Flash.
3. If a `serial` MCP tool is available (`serial_monitor`, `serial_send_command`), watch boot/debug output for the expected behavior — a specific log line, absence of a fault/reset, expected sensor/peripheral output — rather than declaring success from the build succeeding alone.
4. If no hardware is attached or no serial/build tooling is configured, say so explicitly and tell the user what to verify themselves. Do not claim a hardware-dependent change works when it was never run on hardware.

## Safety and blast radius

Never flash, erase, or send commands to a device without the user's request or clear implication that's the task at hand — a bad flash can brick a board or, on a bench with real power/motors/actuators attached, cause physical harm. When a command's effect on the attached hardware is unclear (which port, which device, is this the only board attached), ask rather than guess.
