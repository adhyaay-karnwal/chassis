#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const outputDir = resolve(process.argv[2] || resolve(repoRoot, "sdk/dist/libchassis"));
const requestedNativeAddons = process.argv.slice(3).map((path) => resolve(path));
const defaultNativeAddon = resolve(repoRoot, "zig-out/lib/libchassis.node");
const nativeAddons = requestedNativeAddons.length ? requestedNativeAddons : [defaultNativeAddon];
const requiredNativeNames = new Set([
  "libchassis.linux-x64.node",
  "libchassis.linux-arm64.node",
  "libchassis.darwin-x64.node",
  "libchassis.darwin-arm64.node",
]);
const localNativeName = {
  "linux-x64": "libchassis.linux-x64.node",
  "linux-arm64": "libchassis.linux-arm64.node",
  "darwin-x64": "libchassis.darwin-x64.node",
  "darwin-arm64": "libchassis.darwin-arm64.node",
}[`${process.platform}-${process.arch}`];
const files = [
  ["sdk/package.json", "package.json"],
  ["sdk/README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["sdk/browser.js", "browser.js"],
  ["sdk/node.js", "node.js"],
  ["sdk/chassis-sdk.js", "chassis-sdk.js"],
  ["sdk/wasm-module.js", "wasm-module.js"],
  ["sdk/core-output.js", "core-output.js"],
  ["sdk/mcp.js", "mcp.js"],
  ["sdk/skills.js", "skills.js"],
  ["sdk/skills-node.js", "skills-node.js"],
  ["zig-out/bin/chassis-core.wasm", "chassis-core.wasm"],
  ["zig-out/bin/chassis-term.wasm", "chassis-term.wasm"],
];

if (requestedNativeAddons.length) {
  const names = nativeAddons.map((addon) => basename(addon));
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const missing = [...requiredNativeNames].filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !requiredNativeNames.has(name));
  if (duplicates.length || missing.length || unexpected.length) {
    throw new Error([
      "publishable package requires exactly one addon for every supported platform",
      duplicates.length ? `duplicates: ${duplicates.join(", ")}` : null,
      missing.length ? `missing: ${missing.join(", ")}` : null,
      unexpected.length ? `unexpected: ${unexpected.join(", ")}` : null,
    ].filter(Boolean).join("; "));
  }
}
if (!requestedNativeAddons.length && !localNativeName) {
  throw new Error(`local native packaging is unsupported on ${process.platform}-${process.arch}`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const cjsBuild = spawnSync(process.execPath, [
  resolve(repoRoot, "sdk/scripts/build-node-cjs.mjs"),
  resolve(outputDir, "node.cjs"),
], { cwd: repoRoot, stdio: "inherit" });
if (cjsBuild.error) throw cjsBuild.error;
if (cjsBuild.status !== 0) process.exit(cjsBuild.status ?? 1);
for (const [source, destination] of files) {
  await cp(resolve(repoRoot, source), resolve(outputDir, destination));
}
for (const addon of nativeAddons) {
  if (!addon.endsWith(".node")) throw new Error(`native addon must end in .node: ${addon}`);
  const destination = requestedNativeAddons.length ? basename(addon) : localNativeName;
  await cp(addon, resolve(outputDir, destination));
}

const manifest = JSON.parse(await readFile(resolve(outputDir, "package.json"), "utf8"));
manifest.files = undefined;
await writeFile(resolve(outputDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`packaged ${manifest.name} in ${outputDir}`);
console.log("  node.cjs");
for (const [, destination] of files) console.log(`  ${destination}`);
for (const addon of nativeAddons) {
  console.log(`  ${requestedNativeAddons.length ? basename(addon) : localNativeName}`);
}
