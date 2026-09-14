import type { ChunkRecord } from "./types.js";

/** Target chunk size and overlap, in whitespace-delimited words. */
const CHUNK_WORDS = 300;
const CHUNK_OVERLAP_WORDS = 50;

interface WordToken {
  word: string;
  page: number;
}

/**
 * Splits per-page text into overlapping, page-attributed chunks.
 *
 * `pages` is an array of raw page text, one entry per page (1-indexed implicitly by
 * array position: pages[0] is page 1). Chunks are built by sliding a fixed-size window
 * over the flattened word stream so that a chunk may span a page boundary; in that case
 * pageStart/pageEnd differ, which downstream citation logic renders as a page range.
 */
export function chunkPages(pages: string[]): Array<{ text: string; pageStart: number; pageEnd: number }> {
  const tokens: WordToken[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = i + 1;
    const words = normalizeWhitespace(pages[i]).split(" ").filter(Boolean);
    for (const word of words) {
      tokens.push({ word, page });
    }
  }

  if (tokens.length === 0) {
    return [];
  }

  const chunks: Array<{ text: string; pageStart: number; pageEnd: number }> = [];
  const step = Math.max(1, CHUNK_WORDS - CHUNK_OVERLAP_WORDS);

  for (let start = 0; start < tokens.length; start += step) {
    const slice = tokens.slice(start, start + CHUNK_WORDS);
    if (slice.length === 0) break;
    const text = slice.map((t) => t.word).join(" ");
    const pageStart = slice[0].page;
    const pageEnd = slice[slice.length - 1].page;
    chunks.push({ text, pageStart, pageEnd });
    if (start + CHUNK_WORDS >= tokens.length) break;
  }

  return chunks;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildChunkRecords(
  docId: string,
  filename: string,
  pages: string[]
): Array<Omit<ChunkRecord, "embedding">> {
  const raw = chunkPages(pages);
  return raw.map((c, i) => ({
    id: `${docId}#${i}`,
    docId,
    filename,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    text: c.text,
  }));
}
