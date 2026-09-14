/**
 * Optional embedding-based semantic search support.
 *
 * This module is entirely inert unless the user explicitly sets EMBEDDING_API_KEY
 * and EMBEDDING_BASE_URL in the environment the MCP server is launched with (i.e. the
 * `env` block of the server's entry in .mcp.json). If either is missing, every
 * function here becomes a no-op / returns null and no network request is ever made.
 * This is the local-first guarantee: datasheet content never leaves the machine
 * unless the user opts in.
 */

const DEFAULT_MODEL = "text-embedding-3-small";

export function embeddingsConfigured(): boolean {
  return Boolean(process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_BASE_URL);
}

export function embeddingModel(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
}

/**
 * Requests embeddings for a batch of texts from an OpenAI-compatible
 * `POST {base}/embeddings` endpoint. Returns null (never throws) if embeddings are
 * not configured, or if the request fails for any reason (network error, non-2xx
 * response, unexpected payload shape) — callers should treat null as "fall back to
 * lexical search" rather than as an error to surface to the user, since running
 * without semantic search is the expected, fully-supported default mode.
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!embeddingsConfigured() || texts.length === 0) return null;

  const baseUrl = process.env.EMBEDDING_BASE_URL!.replace(/\/+$/, "");
  const apiKey = process.env.EMBEDDING_API_KEY!;
  const model = embeddingModel();

  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
    });

    if (!res.ok) {
      process.stderr.write(
        `[datasheet-mcp] embedding request failed (${res.status} ${res.statusText}); falling back to lexical search.\n`
      );
      return null;
    }

    const json: any = await res.json();
    const data = json?.data;
    if (!Array.isArray(data)) {
      process.stderr.write("[datasheet-mcp] embedding response missing `data` array; falling back to lexical search.\n");
      return null;
    }

    // Preserve input order via the `index` field when present, else assume order matches.
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => d.embedding as number[]);
  } catch (err) {
    process.stderr.write(
      `[datasheet-mcp] embedding request errored (${(err as Error).message}); falling back to lexical search.\n`
    );
    return null;
  }
}

export async function embedOne(text: string): Promise<number[] | null> {
  const result = await embedTexts([text]);
  return result ? result[0] : null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
