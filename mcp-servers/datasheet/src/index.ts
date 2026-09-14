#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { embeddingsConfigured, embeddingModel } from "./embeddings.js";
import { ingestFile } from "./ingest.js";
import { searchChunks } from "./search.js";
import { DatasheetStore, resolveIndexDir } from "./store.js";

const indexDir = resolveIndexDir();
const store = new DatasheetStore(indexDir);

const server = new McpServer({
  name: "chassis-datasheet",
  version: "0.1.0",
});

server.registerTool(
  "ingest_document",
  {
    title: "Ingest a datasheet document",
    description:
      "Extracts text from a hardware document (datasheet, reference manual, errata sheet) and adds it " +
      "to the local search index so search_datasheets can find it. Supports PDF (.pdf) and plain " +
      "text/markdown (.txt, .md, .markdown, .text). For PDFs, text is extracted per-page so search " +
      "results can cite an exact page number. The document is split into overlapping ~300-word chunks " +
      "tagged with their source page(s). Re-ingesting a file with the same filename overwrites the " +
      "previous version of that document in the index (use this when a datasheet is superseded by a " +
      "new revision with the same filename, or call remove_document first if the filename changed). " +
      "This only reads the local file at `path` — it does not fetch or upload anything over the network, " +
      "unless EMBEDDING_API_KEY/EMBEDDING_BASE_URL are configured, in which case chunk text is also sent " +
      "to that embeddings endpoint to compute optional semantic-search vectors.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "Absolute or working-directory-relative path to a single PDF or text/markdown file to ingest. " +
            "To ingest multiple files, call this tool once per file."
        ),
    },
  },
  async ({ path: filePath }) => {
    try {
      const result = await ingestFile(store, filePath);
      const lines = [
        `Ingested "${result.document.filename}" as document id "${result.document.id}".`,
        `Pages: ${result.document.pageCount}. Chunks: ${result.document.chunkCount}.`,
        result.embeddingsComputed
          ? `Semantic search: enabled (embeddings computed with model "${embeddingModel()}").`
          : embeddingsConfigured()
            ? `Semantic search: NOT enabled for this document (${result.embeddingError ?? "embedding request failed"}). Lexical search still works.`
            : `Semantic search: not configured (EMBEDDING_API_KEY/EMBEDDING_BASE_URL unset). Using lexical (BM25) search only, which is the default and fully supported mode.`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to ingest "${filePath}": ${(err as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "search_datasheets",
  {
    title: "Search ingested datasheets",
    description:
      "Searches the local index of previously-ingested datasheets/manuals for text relevant to `query` " +
      "and returns ranked chunks with their source filename and page number(s), suitable for citing as " +
      "'per <filename>, page <N>: <excerpt>' in your own output. Uses local BM25 keyword search by " +
      "default (no network, no API key needed); if EMBEDDING_API_KEY and EMBEDDING_BASE_URL are " +
      "configured AND the matched documents were ingested with embeddings enabled, results are additionally " +
      "ranked by semantic similarity and blended with the keyword score (mode: \"hybrid\" in the response) " +
      "— otherwise mode is \"lexical\", which is the normal, expected default. " +
      "IMPORTANT: this only searches documents already added via ingest_document — it does not fetch " +
      "anything from the internet or know about datasheets that haven't been explicitly ingested. If a " +
      "search returns nothing useful, check list_documents to see what's actually indexed, or ingest the " +
      "relevant datasheet first.",
    inputSchema: {
      query: z.string().describe("The search query, e.g. a register name, peripheral name, or question about a specific behavior."),
      max_results: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Maximum number of ranked results to return. Defaults to 10."),
      source_filter: z
        .string()
        .optional()
        .describe(
          "Restrict the search to one already-ingested document, identified by its filename or document id " +
            "as shown by list_documents. Omit to search across all ingested documents."
        ),
    },
  },
  async ({ query, max_results, source_filter }) => {
    const limit = max_results ?? 10;

    if (source_filter && !store.getDocument(source_filter)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No ingested document matches source_filter "${source_filter}". Call list_documents to see what's indexed.`,
          },
        ],
      };
    }

    const chunks = store.allChunks(source_filter);
    if (chunks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No documents are ingested yet. Call ingest_document first with the path to a datasheet, reference manual, or errata sheet.",
          },
        ],
      };
    }

    const outcome = await searchChunks(chunks, query, limit);

    if (outcome.results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No matches for "${query}" in the ${chunks.length} indexed chunk(s). Try different terms, or check list_documents to confirm the relevant datasheet is ingested.`,
          },
        ],
      };
    }

    const resultsPayload = outcome.results.map((r, i) => ({
      rank: i + 1,
      score: Number(r.score.toFixed(4)),
      source: r.chunk.filename,
      page: r.chunk.pageStart === r.chunk.pageEnd ? r.chunk.pageStart : `${r.chunk.pageStart}-${r.chunk.pageEnd}`,
      citation: `${r.chunk.filename}, page ${r.chunk.pageStart === r.chunk.pageEnd ? r.chunk.pageStart : `${r.chunk.pageStart}-${r.chunk.pageEnd}`}`,
      text: r.chunk.text,
    }));

    const summary = resultsPayload
      .map((r) => `[${r.rank}] (score ${r.score}) ${r.citation}\n${r.text}`)
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Search mode: ${outcome.mode}. ${resultsPayload.length} result(s) for "${query}":\n\n${summary}`,
        },
      ],
      structuredContent: { mode: outcome.mode, results: resultsPayload },
    };
  }
);

server.registerTool(
  "list_documents",
  {
    title: "List ingested datasheets",
    description:
      "Lists every document currently in the local datasheet index: filename, page count, chunk count, " +
      "ingestion timestamp, and whether semantic-search embeddings are available for it. Use this before " +
      "ingest_document to check whether a datasheet is already indexed, or before search_datasheets to see " +
      "what's searchable.",
    inputSchema: {},
  },
  async () => {
    const docs = store.listDocuments();
    if (docs.length === 0) {
      return { content: [{ type: "text", text: "No documents ingested yet." }] };
    }
    const lines = docs.map(
      (d) =>
        `- ${d.filename} (id: ${d.id}) — ${d.pageCount} page(s), ${d.chunkCount} chunk(s), ` +
        `ingested ${d.ingestedAt}, semantic search: ${d.hasEmbeddings ? "enabled" : "disabled"}`
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { documents: docs },
    };
  }
);

server.registerTool(
  "remove_document",
  {
    title: "Remove a datasheet from the index",
    description:
      "Removes a document and all of its chunks from the local search index, e.g. when a datasheet has " +
      "been superseded by a new revision. Identify the document by filename or id as shown by " +
      "list_documents. This does not delete the original source file on disk, only the index entry.",
    inputSchema: {
      filename: z.string().describe("The filename or document id of the document to remove, as shown by list_documents."),
    },
  },
  async ({ filename }) => {
    const removed = store.removeDocument(filename);
    if (!removed) {
      return {
        isError: true,
        content: [{ type: "text", text: `No ingested document matches "${filename}". Call list_documents to see what's indexed.` }],
      };
    }
    return { content: [{ type: "text", text: `Removed "${removed.filename}" (${removed.chunkCount} chunks) from the index.` }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[datasheet-mcp] ready. index dir: ${indexDir}. semantic search: ${embeddingsConfigured() ? `enabled (model ${embeddingModel()})` : "disabled (lexical-only)"}\n`);
}

main().catch((err) => {
  process.stderr.write(`[datasheet-mcp] fatal error: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
