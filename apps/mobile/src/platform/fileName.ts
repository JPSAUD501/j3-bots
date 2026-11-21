// SPDX-License-Identifier: AGPL-3.0-or-later

/** The longest file name Android's and iOS's file systems take, in UTF-8 bytes. */
const MAX_NAME_BYTES = 255;

/** An extension kept when a long name is shortened: a dot and up to 15 more characters. */
const EXTENSION = /\.[^.]{1,15}$/;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/**
 * The name a file takes in the app's cache, from the name it has in the
 * conversation, which the server takes as the sender gave it. The system's
 * viewer shows it, so it keeps as much of it as a file name can: a path
 * separator or a control character becomes `_`, so the file never lands
 * outside its folder; a name of dots alone becomes `file`; and a name too
 * long for the file system is shortened before its extension, a whole
 * character at a time.
 */
export function localFileName(name: string): string {
  const safe = name.replace(/[/\\\u0000-\u001f\u007f]/g, "_");
  if (/^\.*$/.test(safe)) return "file";
  if (byteLength(safe) <= MAX_NAME_BYTES) return safe;
  const extension = EXTENSION.exec(safe)?.[0] ?? "";
  // By code point, so a character is never cut in two.
  const stem = Array.from(safe.slice(0, safe.length - extension.length));
  while (stem.length > 0 && byteLength(stem.join("") + extension) > MAX_NAME_BYTES) stem.pop();
  return stem.length === 0 ? "file" : stem.join("") + extension;
}
