/**
 * Compact BM25 implementation for local, dependency-free lexical search.
 *
 * BM25 scores each document (here, a chunk) against a query by summing, over each
 * query term, a term-frequency component (saturating, so repeated terms give
 * diminishing returns) weighted by an inverse-document-frequency component (rarer
 * terms count for more) and normalized by document length relative to the corpus
 * average (so long chunks don't win purely by containing more words).
 */

const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g);
  return matches ?? [];
}

export interface Bm25Doc<T> {
  ref: T;
  tokens: string[];
}

export class Bm25Index<T> {
  private docs: Bm25Doc<T>[] = [];
  private docFreq = new Map<string, number>(); // term -> number of docs containing it
  private avgDocLen = 0;

  constructor(docs: Array<{ ref: T; text: string }>) {
    for (const d of docs) {
      const tokens = tokenize(d.text);
      this.docs.push({ ref: d.ref, tokens });
    }
    this.buildStats();
  }

  private buildStats(): void {
    this.docFreq.clear();
    let totalLen = 0;
    for (const doc of this.docs) {
      totalLen += doc.tokens.length;
      const seen = new Set(doc.tokens);
      for (const term of seen) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    this.avgDocLen = this.docs.length > 0 ? totalLen / this.docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.docFreq.get(term) ?? 0;
    // Standard BM25 IDF with a +1 floor to keep values non-negative for common terms.
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  /** Returns {ref, score} sorted descending by score, for docs with score > 0. */
  search(query: string, limit: number): Array<{ ref: T; score: number }> {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.docs.length === 0) return [];

    const termCounts = new Map<string, number>();
    for (const t of queryTerms) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);

    const results: Array<{ ref: T; score: number }> = [];
    for (const doc of this.docs) {
      const docLen = doc.tokens.length;
      if (docLen === 0) continue;
      const tf = new Map<string, number>();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

      let score = 0;
      for (const [term, qCount] of termCounts) {
        const f = tf.get(term);
        if (!f) continue;
        const idf = this.idf(term);
        const numerator = f * (K1 + 1);
        const denominator = f + K1 * (1 - B + (B * docLen) / (this.avgDocLen || 1));
        score += idf * (numerator / denominator) * qCount;
      }

      if (score > 0) {
        results.push({ ref: doc.ref, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
