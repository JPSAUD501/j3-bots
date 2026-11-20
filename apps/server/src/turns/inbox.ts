// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttachmentId } from "@j3-bots/contracts";

/**
 * The most UTF-8 bytes of an inbox file's name: well inside the 255 a file
 * name takes on the file systems a workspace lives on.
 */
const INBOX_NAME_BYTES = 200;

/** The longest extension a shortened name keeps, in bytes with its dot. */
const KEPT_EXTENSION_BYTES = 16;

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

/** The longest start of `text` of at most `bytes` UTF-8 bytes, never splitting a character. */
const leading = (text: string, bytes: number): string => {
  let kept = "";
  let used = 0;
  for (const character of text) {
    used += utf8Length(character);
    if (used > bytes) break;
    kept += character;
  }
  return kept;
};

/**
 * Where an operator's file is copied in the bot's workspace, relative to it.
 * Each file has a folder of its own, named by its id, so two files never take
 * one place. Its name is made one path segment that names no folder (`.`,
 * `..`), shortened to at most `INBOX_NAME_BYTES` bytes, keeping a short
 * extension; the envelope still gives the bot the name the operator gave.
 */
export const inboxPath = (attachment: { readonly id: AttachmentId; readonly name: string }) => {
  const segment = attachment.name.replaceAll(/[/\\]/g, "_");
  const name = /^\.+$/.test(segment) ? "_" : segment;
  if (utf8Length(name) <= INBOX_NAME_BYTES) return `files/inbox/${attachment.id}/${name}`;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const kept = utf8Length(extension) <= KEPT_EXTENSION_BYTES ? extension : "";
  const stem = leading(
    name.slice(0, name.length - kept.length),
    INBOX_NAME_BYTES - utf8Length(kept),
  );
  return `files/inbox/${attachment.id}/${stem}${kept}`;
};
