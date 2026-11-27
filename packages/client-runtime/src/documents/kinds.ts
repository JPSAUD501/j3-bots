// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_ATTACHMENT_SIZE } from "@j3-bots/contracts";

/** The documents a client shows in its own viewer. */
export type DocumentKind = "pdf" | "text" | "markdown" | "csv" | "sheet" | "word" | "slides";

const BY_TYPE: ReadonlyMap<string, DocumentKind> = new Map([
  ["application/pdf", "pdf"],
  ["text/plain", "text"],
  ["application/json", "text"],
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
  ["text/csv", "csv"],
  ["text/tab-separated-values", "csv"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "slides"],
]);

const BY_EXTENSION: ReadonlyMap<string, DocumentKind> = new Map([
  ["pdf", "pdf"],
  ["txt", "text"],
  ["text", "text"],
  ["log", "text"],
  ["json", "text"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["csv", "csv"],
  ["tsv", "csv"],
  ["xlsx", "sheet"],
  ["docx", "word"],
  ["pptx", "slides"],
]);

/**
 * Media types that say nothing of a file's kind, which a device or a bot's
 * workspace gives a file it has no type for. A zip is one: a Word, Excel or
 * PowerPoint file is a zip, and some systems name it so.
 */
const UNTYPED: ReadonlySet<string> = new Set(["", "application/octet-stream", "application/zip"]);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/**
 * The kind of document a file is, for the viewer to show it as; null for a
 * file it does not show. Its media type decides, and its name's extension
 * where the type says nothing, or says plain text of a file whose name says
 * Markdown or CSV. What the file's bytes hold is checked again as it is read.
 */
export function documentKind(file: {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}): DocumentKind | null {
  if (file.size === 0 || file.size > MAX_ATTACHMENT_SIZE) return null;
  const type = file.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const byType = BY_TYPE.get(type) ?? null;
  const byName = BY_EXTENSION.get(extensionOf(file.name)) ?? null;
  if (byType === "text" && (byName === "markdown" || byName === "csv")) return byName;
  if (byType !== null) return byType;
  return UNTYPED.has(type) ? byName : null;
}
