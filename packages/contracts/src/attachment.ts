// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { AttachmentId, EntryId, Label, NonNegativeInt } from "./base.ts";

/**
 * A file the operator sent or a bot produced. Its bytes are served to paired
 * devices at `GET /attachments/<id>` (see `http.ts`).
 */
export const Attachment = Schema.Struct({
  id: AttachmentId,
  name: Label,
  mediaType: Label,
  /** Bytes. */
  size: NonNegativeInt,
});
export type Attachment = typeof Attachment.Type;

/** At most this many files in one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * The largest file `POST /attachments` accepts, in bytes. It refuses an empty
 * file. A message can carry less than this per file: see `message.send`.
 */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

/** A file a bot delivered, as the bot's details screen lists it. */
export const BotFile = Schema.Struct({
  attachment: Attachment,
  /** The message it came with. */
  entryId: EntryId,
  createdAt: Schema.DateTimeUtc,
});
export type BotFile = typeof BotFile.Type;
