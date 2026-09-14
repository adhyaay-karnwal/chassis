import { readFile } from "node:fs/promises";
import path from "node:path";
// pdf-parse ships no ESM types; import the CJS default export.
// Pinned to the 1.x line (see package.json) specifically because it exposes the
// `pagerender` hook used below to preserve per-page boundaries during extraction.
// The 2.x rewrite drops this in favor of a heavier pdfjs-dist/@napi-rs/canvas stack
// aimed at image/table extraction, which we don't need here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pdfParse from "pdf-parse";

export interface ExtractedDocument {
  kind: "pdf" | "text";
  /** Raw text per page. pages[0] is page 1. */
  pages: string[];
}

const PDF_EXTENSIONS = new Set([".pdf"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".text"]);

export function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return PDF_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
}

export async function extractDocument(filePath: string): Promise<ExtractedDocument> {
  const ext = path.extname(filePath).toLowerCase();

  if (PDF_EXTENSIONS.has(ext)) {
    return extractPdf(filePath);
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return extractText(filePath);
  }

  throw new Error(
    `Unsupported file type "${ext}". Supported: PDF (.pdf) and plain text/markdown (.txt, .md, .markdown, .text).`
  );
}

async function extractPdf(filePath: string): Promise<ExtractedDocument> {
  const buffer = await readFile(filePath);
  const pages: string[] = [];

  // pdf-parse's `pagerender` hook is called once per page during parsing, letting us
  // capture text with its page number intact instead of losing that boundary in the
  // single concatenated `data.text` blob pdf-parse normally returns.
  await pdfParse(buffer, {
    pagerender: (pageData: any) => {
      const renderOptions = {
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      };
      return pageData.getTextContent(renderOptions).then((textContent: any) => {
        let lastY: number | undefined;
        let text = "";
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || lastY === undefined) {
            text += item.str;
          } else {
            text += "\n" + item.str;
          }
          lastY = item.transform[5];
        }
        pages.push(text);
        return text;
      });
    },
  });

  if (pages.length === 0) {
    throw new Error(`No extractable text found in "${filePath}". It may be a scanned/image-only PDF.`);
  }

  return { kind: "pdf", pages };
}

async function extractText(filePath: string): Promise<ExtractedDocument> {
  const raw = await readFile(filePath, "utf-8");
  // Plain text/markdown files have no inherent page concept. If the file contains
  // form-feed characters (0x0C), a fairly common convention for marking page breaks
  // in exported text, honor them as page boundaries; otherwise treat the whole file
  // as a single page.
  const pages = raw.includes("\f") ? raw.split("\f") : [raw];
  return { kind: "text", pages };
}
