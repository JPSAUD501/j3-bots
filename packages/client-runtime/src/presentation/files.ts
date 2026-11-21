// SPDX-License-Identifier: AGPL-3.0-or-later

/** Which icon a file shows, from its media type. */
export type FileIcon = "image" | "text" | "archive" | "code" | "other";

export function fileIcon(mediaType: string): FileIcon {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf" || mediaType.startsWith("text/")) return "text";
  if (/zip|tar|gzip|compressed/.test(mediaType)) return "archive";
  if (/json|javascript|typescript|xml|yaml/.test(mediaType)) return "code";
  return "other";
}

/** The kind of file in a word, from its media type: "PDF", "PNG", "TXT"; empty when no word fits. */
export function fileKind(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split(/[+;]/)[0] ?? "";
  if (mediaType.startsWith("text/plain")) return "TXT";
  if (subtype === "vnd.openxmlformats-officedocument.wordprocessingml.document") return "DOCX";
  if (subtype === "vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "XLSX";
  return subtype.length > 0 && subtype.length <= 5 ? subtype.toUpperCase() : "";
}
