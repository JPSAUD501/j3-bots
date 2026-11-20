// SPDX-License-Identifier: AGPL-3.0-or-later

// The engine's limits on the files one message carries. **Read** at `db51b67`:
// `packages/contracts/src/chatAttachment.ts` (`PROVIDER_SEND_TURN_*`,
// `getProviderAttachmentLimitError`) and `packages/contracts/src/assets.ts`
// (`AttachmentCreateUploadUrlInput`, which refuses an empty upload).
const MAX_ATTACHMENTS = 100;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES_TOTAL = 80 * 1024 * 1024;
const INLINE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** What the limit check needs to know about one file. */
export interface AttachmentFacts {
  readonly mediaType: string;
  /** Bytes. */
  readonly size: number;
}

/** Why the engine would refuse a message's files. */
export type AttachmentLimitViolation =
  | { readonly _tag: "too-many"; readonly limit: number }
  /** `index` is the file's position in the list. */
  | { readonly _tag: "empty"; readonly index: number }
  | { readonly _tag: "file-too-large"; readonly index: number; readonly limit: number }
  /** An image the model sees inline (GIF, JPEG, PNG or WebP). */
  | { readonly _tag: "image-too-large"; readonly index: number; readonly limit: number }
  /** The inline images together. */
  | { readonly _tag: "images-too-large"; readonly limit: number };

/**
 * Whether the model receives the file as an image rather than as a file it can
 * open. Decides which limits apply.
 */
export const isInlineImage = (mediaType: string): boolean =>
  INLINE_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());

/**
 * The first engine limit the files break, or `undefined` when the engine will
 * take them. The server checks a message's files with it before it commits the
 * dispatch, so a dispatch the engine would refuse is never written.
 */
export const attachmentLimitViolation = (
  attachments: ReadonlyArray<AttachmentFacts>,
): AttachmentLimitViolation | undefined => {
  if (attachments.length > MAX_ATTACHMENTS) return { _tag: "too-many", limit: MAX_ATTACHMENTS };
  let imageBytes = 0;
  for (const [index, { mediaType, size }] of attachments.entries()) {
    if (size < 1) return { _tag: "empty", index };
    if (isInlineImage(mediaType)) {
      if (size > MAX_INLINE_IMAGE_BYTES) {
        return { _tag: "image-too-large", index, limit: MAX_INLINE_IMAGE_BYTES };
      }
      imageBytes += size;
    } else if (size > MAX_FILE_BYTES) {
      return { _tag: "file-too-large", index, limit: MAX_FILE_BYTES };
    }
  }
  return imageBytes > MAX_INLINE_IMAGE_BYTES_TOTAL
    ? { _tag: "images-too-large", limit: MAX_INLINE_IMAGE_BYTES_TOTAL }
    : undefined;
};
