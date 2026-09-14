# @chassis/mcp-datasheet

A local-first MCP server that gives an agent grounded search over hardware
documentation — datasheets, reference manuals, errata sheets — so it can cite real
register addresses, timing constants, and init sequences from your actual documents
instead of hallucinating them.

## Why local-first

Cloud-based "chat with your datasheet" tools are a dealbreaker for a lot of firmware
work: datasheets are frequently covered by an NDA, and engineers repeatedly flag not
wanting to upload confidential documents to a third party just to search them. This
server is designed so that **is never required**:

- By default it runs **fully offline**. Ingesting a PDF/text file and searching it
  both happen entirely on your machine, with local keyword (BM25) search. No network
  calls, no API key, nothing to configure.
- Semantic (embedding-based) search is **opt-in only**. It activates only if you
  explicitly set `EMBEDDING_API_KEY` and `EMBEDDING_BASE_URL` in the server's `env`
  config. If you don't set them, the server never makes an outbound network request —
  this is the expected, fully-supported normal mode, not a degraded fallback.

Datasheet content never leaves your machine unless you deliberately opt into an
external embeddings API.

## What it does

Four MCP tools:

| Tool | Purpose |
|---|---|
| `ingest_document` | Extract text from a PDF or text/markdown file, chunk it, and add it to the local index. |
| `search_datasheets` | Keyword (and optionally semantic) search over everything ingested so far, returning ranked, page-cited excerpts. |
| `list_documents` | Show what's currently indexed (filename, pages, chunks, ingestion time, semantic-search status). |
| `remove_document` | Drop a document (e.g. a superseded datasheet revision) from the index. |

`search_datasheets` only searches documents you've explicitly ingested — it never
fetches anything from the internet. Each result includes the source filename and page
number(s) so an agent can cite `"per <filename>, page <N>: ..."` in its own output.

## Search modes

1. **Lexical (default, always available).** A compact local BM25 implementation
   (`src/bm25.ts`) — standard term-frequency / inverse-document-frequency scoring with
   document-length normalization. Zero configuration, zero network, works out of the
   box.
2. **Semantic (optional).** If `EMBEDDING_API_KEY` and `EMBEDDING_BASE_URL` are set
   when the server starts, `ingest_document` also computes and caches an embedding per
   chunk via an OpenAI-compatible `POST {base}/embeddings` endpoint. `search_datasheets`
   then blends cosine-similarity scores with BM25 (`mode: "hybrid"` in the response;
   `mode: "lexical"` otherwise). `EMBEDDING_MODEL` defaults to `text-embedding-3-small`
   if unset. If the embedding request fails for any reason (bad key, network error,
   unreachable endpoint), the server logs a note to stderr and silently falls back to
   lexical-only for that operation — it never crashes or blocks ingestion/search on
   embedding failures.

   Note: semantic-search *quality* against a real embeddings provider is untested in
   this repo's own verification (no API key available here) — see Verification below.

## Storage

Plain JSON files under an index directory — no external database process, no native
build dependencies:

```
<index dir>/
  index.json          # manifest: one entry per ingested document
  chunks/<docId>.json # chunk records (text, page range, optional embedding) per document
```

The index directory defaults to `.chassis/datasheet-index` relative to the directory
the server is launched from (`process.cwd()`), or override with `DATASHEET_INDEX_DIR`.

The whole index is loaded into memory once at server startup; `search_datasheets`
scores against that in-memory copy rather than re-reading PDFs on every query.

**Scaling limits:** this is sized for a firmware project's own reference material —
realistically dozens to a few hundred documents. It is not meant to scale to a
corpus of thousands of large PDFs; at that scale an embedded database with real
on-disk indexing (e.g. `better-sqlite3` + FTS5) would be the better trade-off. Plain
JSON was chosen instead because it has zero native/compiled dependencies to install
and is trivially inspectable — a good fit for a project-local reference index.

## PDF extraction

Uses [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) (pinned to the `1.x` line
via `^1.1.1`) for its `pagerender` hook, which is called once per page during parsing.
That hook is used to capture text **with its page number attached**, instead of the
single concatenated blob `pdf-parse` returns by default — this is what lets
`search_datasheets` cite an exact page. (`pdf-parse` publishes a `2.x` line as well,
a heavier rewrite built on `pdfjs-dist` + `@napi-rs/canvas` aimed at image/table
extraction; that adds a native-canvas dependency this server doesn't need, so `1.x`
was chosen deliberately.)

Plain text/markdown files have no inherent page concept: if the file contains
form-feed characters (`\f`), they're honored as page breaks (a common convention in
exported text); otherwise the whole file is treated as page 1.

Extracted text is split into overlapping ~300-word chunks (50-word overlap) tagged
with the page(s) they came from — a chunk that happens to straddle a page boundary is
tagged with a page range (e.g. `"page": "4-5"`).

## Install / build

```sh
cd mcp-servers/datasheet
npm install
npm run build      # compiles src/ -> dist/
npm run typecheck  # type-check only, no emit
```

## Configure in `.mcp.json`

Add this to your workspace's `.mcp.json` (or `~/.chassis/mcp.json`):

```json
{
  "mcpServers": {
    "datasheet": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/datasheet/dist/index.js"],
      "env": {
        "DATASHEET_INDEX_DIR": ".chassis/datasheet-index"
      }
    }
  }
}
```

To enable optional semantic search, add the embedding env vars to that same `env`
block:

```json
{
  "mcpServers": {
    "datasheet": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/datasheet/dist/index.js"],
      "env": {
        "DATASHEET_INDEX_DIR": ".chassis/datasheet-index",
        "EMBEDDING_API_KEY": "sk-...",
        "EMBEDDING_BASE_URL": "https://api.openai.com/v1",
        "EMBEDDING_MODEL": "text-embedding-3-small"
      }
    }
  }
}
```

Omit the three `EMBEDDING_*` vars to stay fully offline (the default). Documents
ingested before enabling semantic search won't have embeddings — re-run
`ingest_document` on them after enabling it if you want hybrid search for that
document.

## Usage

1. Ingest one or more datasheets:
   - `ingest_document({ path: "./docs/stm32f103-reference-manual.pdf" })`
   - Re-ingesting a file with the same filename overwrites the previous version in the
     index — useful when a datasheet is superseded by a new revision with the same
     filename.
2. Check what's indexed: `list_documents({})`
3. Search: `search_datasheets({ query: "GPIO alternate function remap register" })`
   - Optionally scope to one document: `source_filter: "stm32f103-reference-manual.pdf"`
4. Drop a stale document: `remove_document({ filename: "old-revision.pdf" })`

## Verification performed

- `npm install` and `npm run build` succeed; `tsc --noEmit` is clean.
- `scripts/smoke-test.mjs` is a real end-to-end test: it builds the server, spawns
  `dist/index.js` as an actual subprocess, and drives it over real MCP JSON-RPC/stdio
  using the MCP SDK's `Client` + `StdioClientTransport` (the same path a real client
  like chassis uses) — not an in-process function call. It:
  1. Confirms `list_documents` reports empty on a fresh index.
  2. Ingests a synthetic two-page Markdown "datasheet" (a fake `TMR0` timer peripheral
     with a fake register address, bit-field descriptions, and an init sequence) using
     form-feed page breaks, long enough per page that it's split into multiple chunks.
  3. Confirms the document shows up in `list_documents` with the right page/chunk
     counts, persisted to disk (`DATASHEET_INDEX_DIR` in a temp dir).
  4. Searches for terms that only appear on page 2 and confirms the top result cites
     page 2 and contains the actual matched text (`ONESHOT`, `TMR0_ARR`).
  5. Searches for terms that only appear on page 1 and confirms page-1 attribution.
  6. Confirms an unknown `source_filter` returns a clean tool error rather than a
     crash, and that searching an empty/post-removal index returns a clear "nothing
     ingested" message rather than erroring.
  7. Removes the document and confirms it disappears from both `list_documents` and
     search results.

  Run it with `npm run smoke-test` (after `npm run build`).

- Separately verified (manually, not part of the committed test) that setting
  `EMBEDDING_API_KEY`/`EMBEDDING_BASE_URL` to an intentionally-unreachable endpoint
  does **not** crash the server: ingestion completes, the embedding request fails
  internally, is caught, and the tool response clearly states embeddings weren't
  computed for that document while lexical search continues to work normally.

**Not verified:** actual semantic-search result quality against a real embeddings
provider — this environment has no real API key to test against. The embedding
request/response handling, error handling, and cosine-similarity blending logic are
implemented and exercised for the "unconfigured" and "unreachable endpoint" paths,
but the happy path (a working provider returning real vectors) has not been run
end-to-end. If you configure a real provider, `ingest_document`'s response will say
whether embeddings were actually computed for that document.

## Constraints / design notes

- Pure TypeScript/Node package, independent of the Zig `chassis` build — `npm install`
  + `npm run build` is all that's required.
- No native/compiled dependencies (no `better-sqlite3`, no PDF-to-image rendering).
- No multi-backend storage abstraction, no cloud storage integration beyond the single
  optional embeddings-API path described above.
