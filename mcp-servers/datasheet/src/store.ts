import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChunkRecord, DocumentRecord, IndexManifest } from "./types.js";

/**
 * Plain-JSON index storage.
 *
 * Chosen over an embedded database (e.g. better-sqlite3) for zero native build
 * dependencies — this package has no compiled artifacts to install, which matters
 * for a tool that should "just work" via `npm install && npm run build` on any
 * engineer's machine. A firmware project's datasheet corpus is realistically dozens
 * to a few hundred documents; the whole index is loaded into memory at server start
 * and BM25/cosine scoring runs over that in-memory copy, which is fast at this scale.
 *
 * Layout under the index directory:
 *   index.json           - manifest: list of DocumentRecord
 *   chunks/<docId>.json  - ChunkRecord[] for that document
 *
 * This does not scale to a "search the whole internet's worth of datasheets" corpus
 * (thousands+ documents) — at that point a real embedded DB with disk-backed indexing
 * would be the right call. For a single firmware project's reference material, plain
 * JSON keeps the implementation simple and fully inspectable/diffable.
 */
export class DatasheetStore {
  private readonly indexDir: string;
  private readonly manifestPath: string;
  private readonly chunksDir: string;

  private manifest: IndexManifest;
  private chunksByDoc = new Map<string, ChunkRecord[]>();

  constructor(indexDir: string) {
    this.indexDir = indexDir;
    this.manifestPath = path.join(indexDir, "index.json");
    this.chunksDir = path.join(indexDir, "chunks");
    mkdirSync(this.chunksDir, { recursive: true });
    this.manifest = this.loadManifest();
    this.loadAllChunks();
  }

  private loadManifest(): IndexManifest {
    if (!existsSync(this.manifestPath)) {
      return { version: 1, documents: [] };
    }
    try {
      const raw = readFileSync(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as IndexManifest;
      if (!parsed.documents) return { version: 1, documents: [] };
      return parsed;
    } catch {
      return { version: 1, documents: [] };
    }
  }

  private loadAllChunks(): void {
    this.chunksByDoc.clear();
    for (const doc of this.manifest.documents) {
      const file = path.join(this.chunksDir, `${doc.id}.json`);
      if (!existsSync(file)) continue;
      try {
        const raw = readFileSync(file, "utf-8");
        this.chunksByDoc.set(doc.id, JSON.parse(raw) as ChunkRecord[]);
      } catch {
        this.chunksByDoc.set(doc.id, []);
      }
    }
  }

  private persistManifest(): void {
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), "utf-8");
  }

  private persistChunks(docId: string): void {
    const chunks = this.chunksByDoc.get(docId) ?? [];
    writeFileSync(path.join(this.chunksDir, `${docId}.json`), JSON.stringify(chunks, null, 2), "utf-8");
  }

  listDocuments(): DocumentRecord[] {
    return [...this.manifest.documents];
  }

  getDocument(idOrFilename: string): DocumentRecord | undefined {
    return this.manifest.documents.find((d) => d.id === idOrFilename || d.filename === idOrFilename);
  }

  /** Replaces any existing document with the same id (re-ingest = overwrite). */
  upsertDocument(doc: DocumentRecord, chunks: ChunkRecord[]): void {
    this.manifest.documents = this.manifest.documents.filter((d) => d.id !== doc.id);
    this.manifest.documents.push(doc);
    this.chunksByDoc.set(doc.id, chunks);
    this.persistManifest();
    this.persistChunks(doc.id);
  }

  removeDocument(idOrFilename: string): DocumentRecord | undefined {
    const doc = this.getDocument(idOrFilename);
    if (!doc) return undefined;
    this.manifest.documents = this.manifest.documents.filter((d) => d.id !== doc.id);
    this.chunksByDoc.delete(doc.id);
    this.persistManifest();
    const file = path.join(this.chunksDir, `${doc.id}.json`);
    if (existsSync(file)) rmSync(file);
    return doc;
  }

  /** All chunks across all documents, optionally filtered to a single document (by id or filename). */
  allChunks(sourceFilter?: string): ChunkRecord[] {
    let docs = this.manifest.documents;
    if (sourceFilter) {
      docs = docs.filter((d) => d.id === sourceFilter || d.filename === sourceFilter);
    }
    const out: ChunkRecord[] = [];
    for (const doc of docs) {
      out.push(...(this.chunksByDoc.get(doc.id) ?? []));
    }
    return out;
  }
}

export function docIdForFilename(filename: string): string {
  // Filesystem- and JSON-key-safe id derived from the filename. Deterministic so
  // re-ingesting the same filename overwrites the prior version (e.g. a revised
  // datasheet PDF with the same name) rather than accumulating duplicates.
  return filename
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveIndexDir(): string {
  return process.env.DATASHEET_INDEX_DIR
    ? path.resolve(process.env.DATASHEET_INDEX_DIR)
    : path.resolve(process.cwd(), ".chassis", "datasheet-index");
}
