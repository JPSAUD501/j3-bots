// SPDX-License-Identifier: AGPL-3.0-or-later

// The engine's limits on the files one message carries and on each upload.
// **Read** at `bc0f04d`: `packages/contracts/src/chatAttachment.ts`
// (`PROVIDER_SEND_TURN_*`, `getProviderAttachmentLimitError`) and
// `packages/contracts/src/assets.ts` (`AttachmentCreateUploadUrlInput`: a
// trimmed name of 1 to 255 characters, a trimmed media type of 1 to 100, one of
// the four image types for an image, and no empty upload).
const MAX_ATTACHMENTS = 100;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES_TOTAL = 80 * 1024 * 1024;
// J3 Bots' own limit on names is lower (`MAX_ATTACHMENT_NAME_LENGTH` in the
// contracts, 200), and the server checks it first; this is the engine's.
const MAX_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 100;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
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
 * Whether the engine takes the file as an attachment of a message: an image
 * the model sees inline, whose own limits `attachmentLimitViolation` checks,
 * or any other file of at most 50 MiB. The engine refuses to stage a larger
 * one, so such a file (a screen recording) goes to the bot only through its
 * workspace, and the message names it there.
 */
export const engineCarries = (file: AttachmentFacts): boolean =>
  isInlineImage(file.mediaType) || file.size <= MAX_FILE_BYTES;

/**
 * The first engine limit the files break, or `undefined` when the engine will
 * take them. The server checks a message's files with it before it commits the
 * dispatch, so a dispatch the engine would refuse is never written. A file the
 * engine does not carry (`engineCarries`) is never staged, so no limit of the
 * engine's counts it.
 */
export const attachmentLimitViolation = (
  attachments: ReadonlyArray<AttachmentFacts>,
): AttachmentLimitViolation | undefined => {
  const carried = attachments.flatMap((file, index) =>
    engineCarries(file) ? [{ ...file, index }] : [],
  );
  if (carried.length > MAX_ATTACHMENTS) return { _tag: "too-many", limit: MAX_ATTACHMENTS };
  let imageBytes = 0;
  for (const { mediaType, size, index } of carried) {
    if (size < 1) return { _tag: "empty", index };
    if (isInlineImage(mediaType)) {
      if (size > MAX_INLINE_IMAGE_BYTES) {
        return { _tag: "image-too-large", index, limit: MAX_INLINE_IMAGE_BYTES };
      }
      imageBytes += size;
    }
  }
  return imageBytes > MAX_INLINE_IMAGE_BYTES_TOTAL
    ? { _tag: "images-too-large", limit: MAX_INLINE_IMAGE_BYTES_TOTAL }
    : undefined;
};

/** A file's name and media type in the form the engine stages them. */
export interface AttachmentMetadata {
  readonly name: string;
  readonly mediaType: string;
}

/**
 * A file's name and media type made acceptable to the engine's upload, or
 * `undefined` when they cannot be: the name trimmed, the media type without
 * parameters, trimmed and lowercased. The server applies it when a file is
 * uploaded, refusing the upload on `undefined`, and stores the result, so the
 * engine is never handed metadata it would refuse.
 */
export const normalizeAttachmentMetadata = (input: {
  readonly name: string;
  readonly mediaType: string;
}): AttachmentMetadata | undefined => {
  const name = input.name.trim();
  const mediaType = (input.mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return name.length >= 1 &&
    name.length <= MAX_NAME_LENGTH &&
    mediaType.length <= MAX_MEDIA_TYPE_LENGTH &&
    MEDIA_TYPE.test(mediaType)
    ? { name, mediaType }
    : undefined;
};
