// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import type { Attachment } from "@j3-bots/contracts";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { localFileName } from "./fileName.ts";

/** How opening a file ended, for what the conversation says about it. */
export type OpenOutcome = "opened" | "gone" | "unreachable" | "not-paired" | "failed";

/** The folder in the app's cache that holds the file opened last, and nothing else. */
const opened = () => new Directory(Paths.cache, "opened");

/**
 * Opens a file of the conversation. Its bytes come through the runtime, with
 * this device's credential, and are written to the app's cache under the
 * file's own name; the file opened before it is deleted then. The system's
 * viewer for its type shows it (an app that takes Android's `ACTION_VIEW`
 * for it, or Quick Look on iOS); with none, the share sheet offers to save it
 * or send it to an app that takes it. Either way the file stays out of the
 * app's own view, which runs nothing of it.
 */
export async function openAttachment(
  client: J3Client,
  attachment: Attachment,
): Promise<OpenOutcome> {
  const result = await client.download(attachment);
  if (result._tag === "failed") {
    return result.reason === "not-found" ? "gone" : result.reason;
  }
  try {
    const folder = opened();
    if (folder.exists) folder.delete();
    folder.create({ intermediates: true });
    const file = new File(folder, localFileName(attachment.name));
    file.create();
    await file.write(result.value.bytes);
    const mimeType = attachment.mediaType;
    if (await file.canPreview({ mimeType })) {
      await file.preview({ title: attachment.name, mimeType });
    } else {
      await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: attachment.name });
    }
    return "opened";
  } catch {
    return "failed";
  }
}
