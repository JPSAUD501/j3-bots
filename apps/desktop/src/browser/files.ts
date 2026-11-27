// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_ATTACHMENT_NAME_LENGTH } from "@j3-bots/contracts";

// The names of files the desktop's browser saves: a bot's downloads, which
// the server takes, and the person's, which land in their downloads folder.

const FALLBACK = "download";

/**
 * A name a site gave a file, made safe to save and to send: no folder in
 * it, no control characters, no leading dots, and no longer than an
 * attachment's name may be, keeping its extension.
 */
export const savedName = (given: string): string => {
  const flat = given
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^[.\s]+/, "")
    .trim();
  if (flat === "") return FALLBACK;
  if (flat.length <= MAX_ATTACHMENT_NAME_LENGTH) return flat;
  const dot = flat.lastIndexOf(".");
  const extension = dot > 0 && flat.length - dot <= 16 ? flat.slice(dot) : "";
  return `${flat.slice(0, MAX_ATTACHMENT_NAME_LENGTH - extension.length)}${extension}`;
};

/**
 * `name`, or `name (2)`, `name (3)`… before its extension: the first that
 * `taken` says is free, as a browser names a second download of a file.
 */
export const freeName = (name: string, taken: (candidate: string) => boolean): string => {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let count = 2; ; count += 1) {
    const candidate = `${stem} (${count})${extension}`;
    if (!taken(candidate)) return candidate;
  }
};
