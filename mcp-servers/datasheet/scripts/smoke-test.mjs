#!/usr/bin/env node
// End-to-end smoke test: spawns the built MCP server as a real subprocess and drives
// it over the actual JSON-RPC/stdio protocol using the MCP SDK's client, exactly like
// a real client (e.g. chassis itself) would. Verifies the full pipeline: extract ->
// chunk -> index -> persist -> query -> rank -> cite.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "..", "dist", "index.js");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`OK: ${msg}`);
}

async function run() {
  const workDir = mkdtempSync(path.join(tmpdir(), "chassis-datasheet-smoke-"));
  const indexDir = path.join(workDir, ".chassis", "datasheet-index");
  const sampleDoc = path.join(workDir, "fakemcu-peripheral-guide.md");

  // A synthetic "datasheet-like" doc with a made-up register, spread over two
  // form-feed-delimited pages so we can verify page-attributed citations.
  // Padding filler pushes each page past the ~300-word chunk window so the two pages
  // land in distinct chunks, which is a stronger test of per-page attribution than a
  // single chunk that happens to span both pages.
  const filler = (label) =>
    Array.from(
      { length: 60 },
      (_, i) => `${label} filler sentence number ${i} describing unrelated boilerplate padding text.`
    ).join(" ");

  const page1 = [
    "# FakeMCU32 Timer Peripheral (TMR0) Reference",
    "",
    "## Overview",
    "The TMR0 peripheral is a 16-bit general purpose timer found on the FakeMCU32 family.",
    "It supports up to four capture/compare channels and can generate PWM output.",
    "",
    "## Register Map",
    "TMR0_CTRL is located at base address 0x4001_0000 and controls the timer enable bit,",
    "clock prescaler selection, and one-shot versus continuous counting mode.",
    "",
    filler("page1"),
  ].join("\n");

  const page2 = [
    "## TMR0_CTRL Bit Fields",
    "Bit 0 (EN): Timer enable. Setting this bit to 1 starts the counter at the value in TMR0_CNT.",
    "Bits 3:1 (PRESCALE): Selects the input clock prescaler, from divide-by-1 to divide-by-128.",
    "Bit 7 (ONESHOT): When set, the timer counts once to TMR0_ARR and then stops automatically.",
    "",
    "## Initialization Sequence",
    "1. Write the desired prescaler value to TMR0_CTRL bits 3:1.",
    "2. Write the auto-reload value to TMR0_ARR.",
    "3. Set TMR0_CTRL.EN to 1 to start counting.",
    "",
    filler("page2"),
  ].join("\n");

  writeFileSync(sampleDoc, `${page1}\f${page2}`, "utf-8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, DATASHEET_INDEX_DIR: indexDir },
    stderr: "pipe",
  });

  const client = new Client({ name: "smoke-test-client", version: "0.0.1" });
  await client.connect(transport);

  try {
    // 1. list_documents on an empty index
    const emptyList = await client.callTool({ name: "list_documents", arguments: {} });
    assert(!emptyList.isError, "list_documents succeeds on empty index");
    const emptyText = emptyList.content[0].text;
    assert(emptyText.includes("No documents ingested"), "empty index reports no documents");

    // 2. ingest the sample document
    const ingestRes = await client.callTool({ name: "ingest_document", arguments: { path: sampleDoc } });
    assert(!ingestRes.isError, "ingest_document succeeds");
    const ingestText = ingestRes.content[0].text;
    console.log("--- ingest_document output ---\n" + ingestText);
    assert(ingestText.includes("Pages: 2"), "ingested document reports 2 pages (form-feed split honored)");
    assert(ingestText.includes("Semantic search: not configured"), "semantic search correctly reported as not configured (no env vars set)");

    // 3. list_documents shows the ingested doc, persisted to disk
    const list = await client.callTool({ name: "list_documents", arguments: {} });
    const listText = list.content[0].text;
    console.log("--- list_documents output ---\n" + listText);
    assert(listText.includes("fakemcu-peripheral-guide.md"), "list_documents shows the ingested file");
    assert(listText.includes("semantic search: disabled"), "list_documents shows semantic search disabled");

    // 4. search for a term that only appears on page 2 (TMR0_CTRL.EN / ONESHOT init sequence)
    const search1 = await client.callTool({
      name: "search_datasheets",
      arguments: { query: "TMR0_CTRL enable bit initialization sequence", max_results: 5 },
    });
    assert(!search1.isError, "search_datasheets succeeds");
    const s1 = search1.structuredContent;
    console.log("--- search_datasheets (init sequence) structured result ---\n" + JSON.stringify(s1, null, 2));
    assert(s1.mode === "lexical", "search runs in lexical mode with no embedding env vars set");
    assert(s1.results.length > 0, "search returns at least one result");
    assert(s1.results[0].source === "fakemcu-peripheral-guide.md", "top result cites the correct source filename");
    assert(
      s1.results.some((r) => String(r.page).includes("2")),
      "a result cites page 2, where the initialization sequence text lives"
    );
    assert(
      s1.results.some((r) => r.text.includes("ONESHOT") || r.text.includes("TMR0_ARR")),
      "returned chunk text actually contains matched content from the source document"
    );

    // 5. search for a term that only appears on page 1 (overview) to check page 1 attribution
    const search2 = await client.callTool({
      name: "search_datasheets",
      arguments: { query: "capture compare channels PWM overview", max_results: 5 },
    });
    const s2 = search2.structuredContent;
    assert(
      s2.results.some((r) => String(r.page).includes("1")),
      "a result for an overview-section query cites page 1"
    );

    // 6. source_filter with a nonexistent document should error cleanly, not crash
    const badFilter = await client.callTool({
      name: "search_datasheets",
      arguments: { query: "anything", source_filter: "does-not-exist.pdf" },
    });
    assert(badFilter.isError === true, "search with an unknown source_filter returns a clean tool error, not a crash");

    // 7. remove_document, then confirm it's gone from both list and search
    const removeRes = await client.callTool({ name: "remove_document", arguments: { filename: "fakemcu-peripheral-guide.md" } });
    assert(!removeRes.isError, "remove_document succeeds");
    console.log("--- remove_document output ---\n" + removeRes.content[0].text);

    const listAfterRemove = await client.callTool({ name: "list_documents", arguments: {} });
    assert(listAfterRemove.content[0].text.includes("No documents ingested"), "index is empty again after remove_document");

    const searchAfterRemove = await client.callTool({ name: "search_datasheets", arguments: { query: "TMR0" } });
    assert(
      searchAfterRemove.content[0].text.includes("No documents are ingested"),
      "search after removal reports no documents ingested, doesn't error"
    );

    console.log("\nAll smoke-test assertions passed.");
  } finally {
    await client.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
