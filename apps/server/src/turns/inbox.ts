// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttachmentId } from "@j3-bots/contracts";

/**
 * Where an operator's file is copied in the bot's workspace, relative to it:
 * its name made one path segment, never one that names a folder (`.`, `..`).
 */
export const inboxPath = (attachment: { readonly id: AttachmentId; readonly name: string }) => {
  const name = attachment.name.replaceAll(/[/\\]/g, "_");
  return `files/inbox/${attachment.id}/${/^\.+$/.test(name) ? "_" : name}`;
};
