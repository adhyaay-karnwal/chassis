#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Throwaway smoke test: spawns the built MCP server over stdio, performs the
// MCP `initialize` handshake, lists tools, and calls `list_serial_ports` for
// real. This does not require any serial hardware to be attached — it only
// proves the server process starts, speaks JSON-RPC correctly, and that the
// enumeration tool doesn't throw. Run with: node scripts/smoke-test.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "index.js");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for response to ${method}`)), 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method} error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify(payload) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function fail(msg) {
  console.error("SMOKE TEST FAILED:", msg);
  if (stderrBuf) console.error("--- server stderr ---\n" + stderrBuf);
  child.kill();
  process.exit(1);
}

try {
  const initResult = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  console.log("initialize OK, server:", initResult.serverInfo);

  notify("notifications/initialized", {});

  const toolsResult = await request("tools/list", {});
  const names = toolsResult.tools.map((t) => t.name).sort();
  console.log("tools/list OK, tools:", names);

  const expected = [
    "close_serial_port",
    "list_serial_ports",
    "serial_monitor",
    "serial_read_history",
    "serial_send_command",
  ];
  for (const name of expected) {
    if (!names.includes(name)) fail(`missing expected tool: ${name}`);
    const tool = toolsResult.tools.find((t) => t.name === name);
    if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
      fail(`tool ${name} has no valid inputSchema`);
    }
  }
  if (names.length !== expected.length) {
    fail(`expected exactly ${expected.length} tools, got ${names.length}: ${names.join(", ")}`);
  }

  const callResult = await request("tools/call", {
    name: "list_serial_ports",
    arguments: {},
  });
  if (callResult.isError) fail(`list_serial_ports returned isError: ${JSON.stringify(callResult)}`);
  const text = callResult.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) fail("list_serial_ports did not return a JSON array");
  console.log(`list_serial_ports OK, ${parsed.length} port(s) found on this machine:`, parsed);

  console.log("\nSMOKE TEST PASSED");
  child.kill();
  process.exit(0);
} catch (err) {
  fail(err.stack || String(err));
}
