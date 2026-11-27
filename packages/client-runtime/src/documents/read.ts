// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCsv } from "./csv.ts";
import type { DocumentKind } from "./kinds.ts";
import { DOCUMENT_LIMITS } from "./limits.ts";
import { readMarkdown } from "./markdown.ts";
import type { DocumentContent, DocumentRead } from "./model.ts";
import { readSheets } from "./sheet.ts";
import { readSlides } from "./slides.ts";
import { decodeText, isRefused, Refused } from "./text.ts";
import { readWord } from "./word.ts";

/** The documents read from their bytes on the device: all but PDF, which each platform draws. */
export type ReadKind = Exclude<DocumentKind, "pdf">;

/** Whether the start of `bytes` holds a NUL, which no text file has and every binary one does. */
const looksBinary = (bytes: Uint8Array) =>
  bytes.subarray(0, 8192).includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe);

/** `text` cut to what is shown, and whether it was. */
const within = (text: string) =>
  text.length > DOCUMENT_LIMITS.textCharacters
    ? { text: text.slice(0, DOCUMENT_LIMITS.textCharacters), cut: true }
    : { text, cut: false };

function contentOf(kind: ReadKind, bytes: Uint8Array, locale: string): DocumentContent {
  switch (kind) {
    case "text": {
      if (looksBinary(bytes)) throw new Refused({ reason: "unreadable" });
      return { _tag: "text", ...within(decodeText(bytes)) };
    }
    case "markdown": {
      if (looksBinary(bytes)) throw new Refused({ reason: "unreadable" });
      const { text, cut } = within(decodeText(bytes));
      return readMarkdown(text, cut);
    }
    case "csv":
    case "tsv":
      if (looksBinary(bytes)) throw new Refused({ reason: "unreadable" });
      return readCsv(decodeText(bytes), kind === "tsv" ? "\t" : null);
    case "sheet":
      return readSheets(bytes, locale);
    case "word":
      return readWord(bytes);
    case "slides":
      return readSlides(bytes);
  }
}

/**
 * Reads a document of `kind` from its bytes, in `locale` for the numbers and
 * dates of a spreadsheet. Never throws: a file past the limits is `tooBig`,
 * and one that is not what its kind says, or that fails to read for any
 * reason at all, is `unreadable`. An encrypted Word, Excel or PowerPoint file
 * is no zip, and neither is one in the formats before 2007: both are unreadable.
 */
export function readDocument(kind: ReadKind, bytes: Uint8Array, locale: string): DocumentRead {
  try {
    return { _tag: "read", content: contentOf(kind, bytes, locale) };
  } catch (error) {
    return isRefused(error) ? { _tag: error.reason } : { _tag: "unreadable" };
  }
}

/** What a document's card says of its size: its pages, sheets, slides or rows, when known. */
export type DocumentFacts =
  | { readonly _tag: "pages"; readonly count: number }
  | { readonly _tag: "sheets"; readonly count: number }
  | { readonly _tag: "slides"; readonly count: number }
  | { readonly _tag: "rows"; readonly count: number; readonly more: boolean }
  | { readonly _tag: "none" };

/** The facts of a document as read. */
export function factsOf(content: DocumentContent): DocumentFacts {
  switch (content._tag) {
    case "text":
      return { _tag: "none" };
    case "flow":
      return content.pages === null ? { _tag: "none" } : { _tag: "pages", count: content.pages };
    case "sheets": {
      const [only] = content.sheets;
      return content.sheets.length === 1 && only !== undefined && only.name === null
        ? { _tag: "rows", count: only.rows.length, more: only.cut }
        : { _tag: "sheets", count: content.sheets.length };
    }
    case "slides":
      return { _tag: "slides", count: content.slides.length };
  }
}
