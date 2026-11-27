// SPDX-License-Identifier: AGPL-3.0-or-later

const MiB = 1024 * 1024;

/**
 * How much of a document a client reads and shows. A file is untrusted: what
 * it holds past these limits is left out (the document says it is `cut`), and
 * a file that would take more than a phone has to read at all is too big
 * (`tooBig`). Every file a conversation carries is at most 25 MiB already.
 */
export const DOCUMENT_LIMITS = {
  /** Characters of a text or Markdown file shown, and of a CSV file read. */
  textCharacters: 1_000_000,
  /** Blocks of a Word or Markdown document shown. */
  blocks: 5_000,
  /** Rows and columns of each sheet shown, and the sheets of a workbook. */
  rows: 2_000,
  columns: 100,
  sheets: 50,
  /** Characters of one cell shown. */
  cellCharacters: 2_000,
  /** Slides of a presentation shown. */
  slides: 300,
  /**
   * Pictures of a document shown, each time one shows counted again: each at
   * most `imageBytes` and `imagePixels` drawn, together at most `imagesBytes`
   * and `imagesPixels`. A picture of a few kilobytes can say it is enormous,
   * and a device would draw every pixel it says it has.
   */
  images: 60,
  imageBytes: 10 * MiB,
  imagesBytes: 40 * MiB,
  imagePixels: 25_000_000,
  imagesPixels: 100_000_000,
  /**
   * Bytes a Word, Excel or PowerPoint file may unpack to: each part read, and
   * all of them together. A zip of a few kilobytes can unpack to gigabytes;
   * unpacking stops at these, whatever the file says its parts hold.
   */
  partBytes: 48 * MiB,
  unpackedBytes: 128 * MiB,
  /** Parts listed in a Word, Excel or PowerPoint file. */
  parts: 10_000,
  /** XML elements of one part made into a tree. */
  elements: 1_000_000,
  /** Pages of a PDF shown. */
  pages: 500,
} as const;

/**
 * The largest document whose card fetches it to show a preview and its
 * pages, sheets or slides. A larger one shows its kind and size only, and is
 * fetched when the operator opens it.
 */
export const CARD_PREVIEW_MAX_SIZE = 8 * MiB;
