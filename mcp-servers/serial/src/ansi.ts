// SPDX-License-Identifier: Apache-2.0

/**
 * Strip ANSI escape sequences (color codes, cursor movement, etc.) from a
 * string so captured serial output is readable as plain text. Small
 * hand-rolled implementation to avoid pulling in an extra dependency for
 * something this simple.
 */
// Matches CSI sequences (ESC [ ... letter) and OSC sequences (ESC ] ... BEL/ST),
// which cover the vast majority of ANSI escapes emitted by firmware UART logs
// (color codes, cursor movement, terminal titles).
const ANSI_PATTERN =
  /[](?:\[[0-?]*[ -/]*[@-~]|\][^]*(?:|\\))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Normalize line endings (CRLF / lone CR used by many firmware UART logs
 * for carriage-return-only line redraws) to plain LF, and strip ANSI
 * escapes. This is the "clean text" transform applied by default to
 * captured serial output.
 */
export function cleanText(input: string): string {
  return stripAnsi(input).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
