// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { AttachmentId, EntryId, NonNegativeInt } from "./base.ts";

/**
 * J3 Bots' limit on a file's name, in characters, after trimming. The engine
 * takes up to 255; J3 Bots keeps names to the length of its other labels.
 */
export const MAX_ATTACHMENT_NAME_LENGTH = 200;

/**
 * A media type as `POST /attachments` stores it: lowercase `type/subtype`,
 * without parameters, at most 100 characters, as the engine takes it.
 */
export const AttachmentMediaType = Schema.String.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
);
export type AttachmentMediaType = typeof AttachmentMediaType.Type;

/**
 * A file the operator sent or a bot produced. Its bytes are served to paired
 * devices at `GET /attachments/<id>` (see `http.ts`).
 */
export const Attachment = Schema.Struct({
  id: AttachmentId,
  /** Trimmed. */
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ATTACHMENT_NAME_LENGTH)),
  mediaType: AttachmentMediaType,
  /** Bytes. */
  size: NonNegativeInt,
});
export type Attachment = typeof Attachment.Type;

/** At most this many files in one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** The files of one message, by id: at most `MAX_ATTACHMENTS_PER_MESSAGE`. */
export const MessageAttachments = Schema.Array(AttachmentId).check(
  Schema.isMaxLength(MAX_ATTACHMENTS_PER_MESSAGE),
);

/**
 * Where each of a message's files stands in its text, as the operator placed
 * it: one offset per file, in the order of the files, in UTF-16 code units (0
 * before the first character, the text's length after the last). Offsets
 * never decrease, so the files are listed in reading order, which is the
 * order a bot's harness receives them in; two files at the same offset stand
 * side by side in their order. An offset is never inside a surrogate pair.
 * See {@link attachmentOffsetsFit}.
 */
export const AttachmentOffsets = Schema.Array(NonNegativeInt).check(
  Schema.isMaxLength(MAX_ATTACHMENTS_PER_MESSAGE),
);
export type AttachmentOffsets = typeof AttachmentOffsets.Type;

const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Whether `offsets` place `count` files in `text` as {@link AttachmentOffsets}
 * describes: one per file, never decreasing, within the text, and none
 * between the two halves of a character.
 */
export const attachmentOffsetsFit = (
  text: string,
  count: number,
  offsets: ReadonlyArray<number>,
): boolean =>
  offsets.length === count &&
  offsets.every(
    (offset, index) =>
      Number.isInteger(offset) &&
      offset >= (offsets[index - 1] ?? 0) &&
      offset <= text.length &&
      !(
        offset > 0 &&
        offset < text.length &&
        isHighSurrogate(text.charCodeAt(offset - 1)) &&
        isLowSurrogate(text.charCodeAt(offset))
      ),
  );

/**
 * The largest file `POST /attachments` accepts, in bytes. It refuses an empty
 * file. A message can carry less than this per file: see `message.send`.
 */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

/**
 * The media types a message passes to the bot's model inline, as images. The
 * engine limits them on top of `MAX_ATTACHMENT_SIZE`: see `message.send`.
 */
export const INLINE_IMAGE_MEDIA_TYPES: ReadonlyArray<string> = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
];

/**
 * The largest inline image one message may carry, in bytes: the largest a
 * model looks at in one piece. Also the largest image a step of a bot's work
 * looked at that the server shows (`HTTP_PATHS.workImages`).
 */
export const MAX_INLINE_IMAGE_SIZE = 10 * 1024 * 1024;

/** The most bytes of inline images one message may carry together. */
export const MAX_INLINE_IMAGES_SIZE = 80 * 1024 * 1024;

/** A file a bot delivered, as the bot's details screen lists it. */
export const BotFile = Schema.Struct({
  attachment: Attachment,
  /** The message it came with. */
  entryId: EntryId,
  createdAt: Schema.DateTimeUtc,
});
export type BotFile = typeof BotFile.Type;
