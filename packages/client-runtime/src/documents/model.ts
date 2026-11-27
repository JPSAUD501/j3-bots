// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/**
 * What a document shows once read: the text, tables and pictures of the
 * file, and nothing else. No markup, style or address of the file survives
 * into it, so drawing it runs nothing of the file and reaches nothing the
 * file names (docs/architecture/security.md, "Documents").
 */

/** A stretch of text in one style. */
export const Run = Schema.Struct({
  text: Schema.String,
  bold: Schema.Boolean,
  italic: Schema.Boolean,
  /** Set in a fixed-width face, as code. */
  code: Schema.Boolean,
});
export type Run = typeof Run.Type;

/** The picture types a client draws without running anything, as the file's first bytes say. */
export const DocumentImageType = Schema.Literals([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export type DocumentImageType = typeof DocumentImageType.Type;

/** A picture inside a document, as its bytes. */
export const DocumentImage = Schema.Struct({
  mediaType: DocumentImageType,
  bytes: Schema.Uint8Array,
});
export type DocumentImage = typeof DocumentImage.Type;

/** One block of a document's flow, top to bottom. */
export const Block = Schema.Union([
  Schema.TaggedStruct("heading", {
    level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    runs: Schema.Array(Run),
  }),
  Schema.TaggedStruct("paragraph", { runs: Schema.Array(Run) }),
  /** An item of a list: its depth from 0, and its marker as it shows ("•", "3.", "b)"). */
  Schema.TaggedStruct("item", {
    depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    marker: Schema.String,
    runs: Schema.Array(Run),
  }),
  Schema.TaggedStruct("quote", { runs: Schema.Array(Run) }),
  Schema.TaggedStruct("code", { text: Schema.String }),
  /** A table, as the text of its cells; `header` when its first row heads it. */
  Schema.TaggedStruct("table", {
    rows: Schema.Array(Schema.Array(Schema.String)),
    header: Schema.Boolean,
  }),
  Schema.TaggedStruct("image", { image: DocumentImage, alt: Schema.String }),
  Schema.TaggedStruct("rule", {}),
]);
export type Block = typeof Block.Type;

/** A sheet of a spreadsheet, or the one table of a CSV file. */
export const Sheet = Schema.Struct({
  /** Its tab's name; null for a CSV file, which has one table and no tabs. */
  name: Schema.NullOr(Schema.String),
  /** Its cells as they show, row by row, each row as wide as `columns`. */
  rows: Schema.Array(Schema.Array(Schema.String)),
  columns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Whether it has more rows or columns than are shown. */
  cut: Schema.Boolean,
});
export type Sheet = typeof Sheet.Type;

/** A slide of a presentation: its title, and what is on it, in the order it was placed. */
export const Slide = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  blocks: Schema.Array(Block),
});
export type Slide = typeof Slide.Type;

/**
 * A document as read. `cut` says more of the file was left out than shows,
 * as the limits allow (`DOCUMENT_LIMITS`).
 */
export const DocumentContent = Schema.Union([
  /** Plain text, line for line. */
  Schema.TaggedStruct("text", { text: Schema.String, cut: Schema.Boolean }),
  /** A flow of blocks: a Word or Markdown document. `pages` as the file says, when it does. */
  Schema.TaggedStruct("flow", {
    blocks: Schema.Array(Block),
    pages: Schema.NullOr(Schema.Int),
    cut: Schema.Boolean,
  }),
  Schema.TaggedStruct("sheets", { sheets: Schema.Array(Sheet), cut: Schema.Boolean }),
  Schema.TaggedStruct("slides", { slides: Schema.Array(Slide), cut: Schema.Boolean }),
]);
export type DocumentContent = typeof DocumentContent.Type;

/**
 * How reading a document ended: read, too big to read on this device, or
 * not readable as what it says it is (damaged, protected by a password, or
 * in an older format).
 */
export const DocumentRead = Schema.Union([
  Schema.TaggedStruct("read", { content: DocumentContent }),
  Schema.TaggedStruct("tooBig", {}),
  Schema.TaggedStruct("unreadable", {}),
]);
export type DocumentRead = typeof DocumentRead.Type;
