import { Bm25Index } from "./bm25.js";
import { cosineSimilarity, embedOne, embeddingsConfigured } from "./embeddings.js";
import type { ChunkRecord } from "./types.js";

export interface SearchResult {
  chunk: ChunkRecord;
  score: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  mode: "lexical" | "hybrid";
}

/**
 * Ranks chunks against a query. Always runs BM25 lexical search. If embeddings are
 * configured (EMBEDDING_API_KEY + EMBEDDING_BASE_URL) AND the chunk set has cached
 * embeddings (computed at ingest time), also computes cosine similarity and blends
 * the two score families (each min-max normalized to [0,1], averaged 50/50) so
 * neither dominates purely by scale. If embeddings are unavailable for any reason,
 * this silently falls back to lexical-only — that is expected normal operation, not
 * an error.
 */
export async function searchChunks(chunks: ChunkRecord[], query: string, limit: number): Promise<SearchOutcome> {
  const bm25 = new Bm25Index(chunks.map((c) => ({ ref: c, text: c.text })));
  const lexicalHits = bm25.search(query, Math.max(limit * 4, limit));

  const canEmbed = embeddingsConfigured() && chunks.some((c) => c.embedding);
  if (!canEmbed || lexicalHits.length === 0) {
    return {
      results: lexicalHits.slice(0, limit).map((h) => ({ chunk: h.ref, score: h.score })),
      mode: "lexical",
    };
  }

  const queryEmbedding = await embedOne(query);
  if (!queryEmbedding) {
    return {
      results: lexicalHits.slice(0, limit).map((h) => ({ chunk: h.ref, score: h.score })),
      mode: "lexical",
    };
  }

  // Score the union of: top lexical hits, plus every chunk that has an embedding
  // (semantic matches can surface chunks with little lexical overlap).
  const candidateMap = new Map<string, ChunkRecord>();
  for (const h of lexicalHits) candidateMap.set(h.ref.id, h.ref);
  for (const c of chunks) if (c.embedding) candidateMap.set(c.id, c);
  const candidates = [...candidateMap.values()];

  const lexicalScoreById = new Map(lexicalHits.map((h) => [h.ref.id, h.score]));
  const semanticScoreById = new Map<string, number>();
  for (const c of candidates) {
    if (c.embedding) {
      semanticScoreById.set(c.id, cosineSimilarity(queryEmbedding, c.embedding));
    }
  }

  const lexicalNorm = normalize([...lexicalScoreById.values()]);
  const semanticNorm = normalize([...semanticScoreById.values()]);

  const blended: SearchResult[] = candidates.map((c) => {
    const lex = lexicalScoreById.has(c.id) ? lexicalNorm(lexicalScoreById.get(c.id)!) : 0;
    const sem = semanticScoreById.has(c.id) ? semanticNorm(semanticScoreById.get(c.id)!) : 0;
    // If only one signal exists for this chunk, don't let it be halved into obscurity
    // relative to chunks with both signals; use whichever signal(s) are present.
    const score = semanticScoreById.has(c.id) && lexicalScoreById.has(c.id) ? 0.5 * lex + 0.5 * sem : lex + sem;
    return { chunk: c, score };
  });

  blended.sort((a, b) => b.score - a.score);
  return { results: blended.slice(0, limit), mode: "hybrid" };
}

function normalize(values: number[]): (v: number) => number {
  if (values.length === 0) return (v) => v;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return () => 1;
  return (v) => (v - min) / (max - min);
}
