// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Shared, SharedFile } from "@j3-bots/client-runtime/presentation";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

const isFile = (payload: SharePayload) =>
  payload.shareType !== "text" && payload.shareType !== "url";

/** Whether a share carries files, which must be resolved to be read. */
export const carriesFiles = (payloads: ReadonlyArray<SharePayload>): boolean =>
  payloads.some(isFile);

/** The values of the payloads of one kind, one after another, or null when there are none. */
const joined = (payloads: ReadonlyArray<SharePayload>, kind: "text" | "url", separator: string) => {
  const values = payloads
    .filter((payload) => payload.shareType === kind)
    .map((payload) => payload.value.trim())
    .filter((value) => value !== "");
  return values.length === 0 ? null : values.join(separator);
};

const lastSegment = (uri: string) => decodeURIComponent(uri.split("/").pop() ?? "");

/**
 * What another app shared, from the payloads the system handed the app and,
 * for a share that carries files, those payloads resolved. Text and links
 * come from the payloads as they are. A file is read from the copy resolving
 * made in the app's own storage, which stays readable after the sending app
 * lets go of its original: its name and media type are the system's, and its
 * size, from `sizeOf`, is that of the bytes the upload will send. Null when
 * nothing in the share can go in a draft.
 */
export const sharedOf = (
  payloads: ReadonlyArray<SharePayload>,
  resolved: ReadonlyArray<ResolvedSharePayload>,
  sizeOf: (uri: string) => number,
): Shared | null => {
  const files = resolved.flatMap((payload): ReadonlyArray<SharedFile> => {
    const uri = payload.contentUri;
    if (!isFile(payload) || uri === null) return [];
    return [
      {
        name: payload.originalName ?? lastSegment(uri),
        mediaType: payload.contentMimeType ?? payload.mimeType ?? "",
        size: sizeOf(uri),
        uri,
      },
    ];
  });
  const text = joined(payloads, "text", "\n\n");
  const url = joined(payloads, "url", "\n");
  return text === null && url === null && files.length === 0 ? null : { text, url, files };
};
