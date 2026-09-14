/** Shared data types for the datasheet index. */

export interface DocumentRecord {
  /** Stable id for the document, derived from the ingested filename. */
  id: string;
  /** Original filename (basename) as shown to users, e.g. "stm32f103-datasheet.pdf". */
  filename: string;
  /** Absolute path the document was ingested from, kept for reference only (not re-read on search). */
  sourcePath: string;
  /** "pdf" or "text" (plain text / markdown). */
  kind: "pdf" | "text";
  /** Number of pages. Text documents without form-feed page breaks report 1. */
  pageCount: number;
  /** Number of chunks produced for this document. */
  chunkCount: number;
  /** ISO 8601 timestamp of ingestion. */
  ingestedAt: string;
  /** Whether chunk embeddings were computed for this document at ingest time. */
  hasEmbeddings: boolean;
}

export interface ChunkRecord {
  /** Unique chunk id: `${docId}#${index}`. */
  id: string;
  docId: string;
  filename: string;
  /** First page the chunk's text came from (1-indexed). */
  pageStart: number;
  /** Last page the chunk's text came from (1-indexed). Equal to pageStart for single-page chunks. */
  pageEnd: number;
  /** Chunk text, whitespace-normalized. */
  text: string;
  /** Optional embedding vector, present only when semantic search was enabled at ingest time. */
  embedding?: number[];
}

export interface IndexManifest {
  version: 1;
  documents: DocumentRecord[];
}
