import { statSync } from "node:fs";
import path from "node:path";
import { buildChunkRecords } from "./chunk.js";
import { embedTexts, embeddingsConfigured } from "./embeddings.js";
import { extractDocument, isSupportedFile } from "./extract.js";
import { docIdForFilename, type DatasheetStore } from "./store.js";
import type { ChunkRecord, DocumentRecord } from "./types.js";

export interface IngestResult {
  document: DocumentRecord;
  embeddingsComputed: boolean;
  embeddingError?: string;
}

export async function ingestFile(store: DatasheetStore, filePath: string): Promise<IngestResult> {
  const resolved = path.resolve(filePath);
  const stat = statSync(resolved); // throws ENOENT with a clear message if missing
  if (!stat.isFile()) {
    throw new Error(`"${filePath}" is not a file. Use the directory-ingest pattern of calling ingest_document once per file.`);
  }
  if (!isSupportedFile(resolved)) {
    throw new Error(
      `Unsupported file type for "${filePath}". Supported: .pdf, .txt, .md, .markdown, .text`
    );
  }

  const filename = path.basename(resolved);
  const docId = docIdForFilename(filename);

  const extracted = await extractDocument(resolved);
  const chunkDrafts = buildChunkRecords(docId, filename, extracted.pages);

  let embeddingsComputed = false;
  let embeddingError: string | undefined;
  let chunks: ChunkRecord[] = chunkDrafts;

  if (embeddingsConfigured() && chunkDrafts.length > 0) {
    const vectors = await embedTexts(chunkDrafts.map((c) => c.text));
    if (vectors && vectors.length === chunkDrafts.length) {
      chunks = chunkDrafts.map((c, i) => ({ ...c, embedding: vectors[i] }));
      embeddingsComputed = true;
    } else {
      embeddingError = "Embedding request did not return usable vectors; stored with lexical search only.";
    }
  }

  const doc: DocumentRecord = {
    id: docId,
    filename,
    sourcePath: resolved,
    kind: extracted.kind,
    pageCount: extracted.pages.length,
    chunkCount: chunks.length,
    ingestedAt: new Date().toISOString(),
    hasEmbeddings: embeddingsComputed,
  };

  store.upsertDocument(doc, chunks);

  return { document: doc, embeddingsComputed, embeddingError };
}
