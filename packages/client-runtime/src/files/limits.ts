// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AttachmentMediaType,
  INLINE_IMAGE_MEDIA_TYPES,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_INLINE_IMAGES_SIZE,
} from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

/** A file as the operator picked it, before it is uploaded. */
export interface LocalFile {
  readonly name: string;
  readonly mediaType: string;
  /** Bytes. */
  readonly size: number;
}

/** Why a file cannot go with a message. */
export type FileProblem =
  | "empty"
  /** Over `MAX_ATTACHMENT_SIZE`. */
  | "too-large"
  /** An inline image over `MAX_INLINE_IMAGE_SIZE`. */
  | "image-too-large"
  /** It would take the message's inline images over `MAX_INLINE_IMAGES_SIZE`. */
  | "images-too-large"
  /** The message already carries `MAX_ATTACHMENTS_PER_MESSAGE` files. */
  | "too-many"
  | "name-too-long"
  /** The server refused it for a reason the client could not foresee. */
  | "refused"
  /** This device is no longer paired, so the file cannot be sent. */
  | "not-paired";

const isMediaType = Schema.is(AttachmentMediaType);

/**
 * The media type the server will store for a file: the platform's, lower
 * case and without parameters, or `application/octet-stream` when the
 * platform gives none or one the server would refuse.
 */
export const normalizeMediaType = (type: string): string => {
  const bare = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return isMediaType(bare) ? bare : "application/octet-stream";
};

const isInlineImage = (file: LocalFile) => INLINE_IMAGE_MEDIA_TYPES.includes(file.mediaType);

const problemOf = (file: LocalFile): FileProblem | null => {
  if (file.size === 0) return "empty";
  if (file.size > MAX_ATTACHMENT_SIZE) return "too-large";
  if (isInlineImage(file) && file.size > MAX_INLINE_IMAGE_SIZE) return "image-too-large";
  const name = file.name.trim();
  if (name.length > MAX_ATTACHMENT_NAME_LENGTH) return "name-too-long";
  return null;
};

/**
 * Whether each of `added` may join a message that already carries `held`,
 * checked against the limits the contract declares: null for a file that
 * may, its problem for one that may not. Files are taken in order, so the
 * eleventh is the one refused for `too-many`.
 */
export const admitFiles = (
  held: ReadonlyArray<LocalFile>,
  added: ReadonlyArray<LocalFile>,
): ReadonlyArray<FileProblem | null> => {
  let count = held.length;
  let images = held.reduce((total, file) => total + (isInlineImage(file) ? file.size : 0), 0);
  return added.map((file) => {
    if (count >= MAX_ATTACHMENTS_PER_MESSAGE) return "too-many";
    const problem = problemOf(file);
    if (problem !== null) return problem;
    if (isInlineImage(file)) {
      if (images + file.size > MAX_INLINE_IMAGES_SIZE) return "images-too-large";
      images += file.size;
    }
    count += 1;
    return null;
  });
};
