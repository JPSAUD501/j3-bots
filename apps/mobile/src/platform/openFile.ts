// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import type { Attachment } from "@j3-bots/contracts";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { localFileName } from "./fileName.ts";

/** How opening a file ended, for what the conversation says about it. */
export type OpenOutcome = "opened" | "gone" | "unreachable" | "too-large" | "not-paired" | "failed";

/** The folder in the app's cache that holds the files opened, one folder each. */
const opened = () => new Directory(Paths.cache, "opened");

/** The opens of this run, in the order they started: each folder's name is its number. */
let started = 0;
/** Whether this run cleared what a previous run of the app left in the folder. */
let cleared = false;
/** The last open that started before the app last forgot its server: none after it keeps a file. */
let forgottenAt = 0;

/** Deletes the folders of the opens that started before open `number`. */
function deleteOlder(root: Directory, number: number) {
  for (const entry of root.list()) {
    if (Number(entry.name) < number) entry.delete();
  }
}

/**
 * Opens a file of the conversation. Its bytes come through the runtime, with
 * this device's credential, and are written to a folder of their own in the
 * app's cache under the file's own name; the files of opens that started
 * before it are deleted then, and one that started after it is never
 * touched, so two opens at once never clash. The first open of a run clears
 * what an earlier run left. The system's viewer for its
 * type shows it (an app that takes Android's `ACTION_VIEW` for it, or Quick
 * Look on iOS); with none, the share sheet offers to save it or send it to
 * an app that takes it. Either way the file stays out of the app's own view,
 * which runs nothing of it.
 */
export async function openAttachment(
  client: J3Client,
  attachment: Attachment,
): Promise<OpenOutcome> {
  const root = opened();
  // Before anything of this run is written, so it never meets a previous run's folder of its number.
  if (!cleared) {
    cleared = true;
    forgetFolder(root);
  }
  started += 1;
  const number = started;
  const result = await client.download(attachment);
  if (result._tag === "failed") {
    return result.reason === "not-found" ? "gone" : result.reason;
  }
  if (number <= forgottenAt) return "not-paired";
  const folder = new Directory(root, String(number));
  try {
    folder.create({ intermediates: true, idempotent: true });
    const file = new File(folder, localFileName(attachment.name));
    file.create();
    await file.write(result.value.bytes);
    // The server was forgotten while the bytes were written: they go with it.
    if (number <= forgottenAt) {
      forgetFolder(folder);
      return "not-paired";
    }
    deleteOlder(root, number);
    const mimeType = attachment.mediaType;
    if (await file.canPreview({ mimeType })) {
      await file.preview({ title: attachment.name, mimeType });
    } else {
      await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: attachment.name });
    }
    return "opened";
  } catch {
    // Forgetting the server meanwhile deletes the folder under the write: that is no failure to say.
    return number <= forgottenAt ? "not-paired" : "failed";
  }
}

/**
 * Hands the files a connector's app offered, once the operator chose to save
 * them, to the share sheet, one after the other, where they save them or
 * send them to an app. Each is written first to a folder of its own in the
 * app's cache, with the opens' files, under a name `connectorAppFileName`
 * made safe; the app's own view runs nothing of them. Resolves false when
 * one could not be written or shared.
 */
export async function shareAppFiles(
  files: ReadonlyArray<{
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }>,
): Promise<boolean> {
  if (files.length === 0) return true;
  const root = opened();
  if (!cleared) {
    cleared = true;
    forgetFolder(root);
  }
  started += 1;
  const number = started;
  const folder = new Directory(root, String(number));
  try {
    folder.create({ intermediates: true, idempotent: true });
    deleteOlder(root, number);
    for (const offered of files) {
      const file = new File(folder, localFileName(offered.name));
      file.create({ overwrite: true });
      await file.write(offered.bytes);
      await Sharing.shareAsync(file.uri, {
        mimeType: offered.mediaType,
        dialogTitle: offered.name,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes every file the app opened, as its server is forgotten or changed,
 * and keeps an open still under way from writing one. A file the cache
 * cannot delete is left to the system, which clears the cache as it needs:
 * leaving the server never waits on it.
 */
export function forgetOpenedFiles(): void {
  forgottenAt = started;
  forgetFolder(opened());
}

/** Deletes a folder, when the cache can: see `forgetOpenedFiles`. */
function forgetFolder(folder: Directory) {
  try {
    if (folder.exists) folder.delete();
  } catch {
    // The cache is the system's to clear.
  }
}
