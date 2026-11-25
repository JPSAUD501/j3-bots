// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoomId } from "@j3-bots/contracts";
import type { SecureRandom } from "effect/crypto";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import {
  type Attributes,
  EnvelopeWriter,
  mentionsOf,
  type RoomMentions,
  type TeammateRef,
  titleOf,
  type WriterClock,
} from "./envelope.ts";
import { NONCE_BYTES, withFreshNonce } from "./nonce.ts";

/**
 * What a bot reads of a room outside its envelopes: the result of
 * `read_room`, and the refusal of a post to a room that moved on since the
 * bot last saw it (`docs/prompts/architecture.md#reading-a-room`). Both frame
 * a room's entries as its envelope does: the operator's words in
 * `<message from="user">`, every bot's in a nonce-tagged `data-` block.
 */

/**
 * The most characters either text renders to. A read is one tool result
 * among the many a turn may take, so it is held well under what one envelope
 * may carry (the engine's input limit): the newest entries that fit go, and
 * the text says how many were left out. The newest one always goes, as an
 * envelope's entry does: every room message fits an envelope alone.
 */
export const ROOM_READ_LIMIT = 50_000;

/** Who wrote an entry a read shows. */
export type RoomReadAuthor =
  /** The operator, by the name they asked to be called, when they gave one. */
  | { readonly type: "user"; readonly name: string | null }
  /** The bot that reads. */
  | { readonly type: "you" }
  | { readonly type: "teammate"; readonly teammate: TeammateRef };

/** A room message as a read shows it: no file is carried, so files are named only. */
export interface RoomReadEntry {
  readonly author: RoomReadAuthor;
  readonly at: DateTime.Utc;
  readonly text: string;
  readonly mentions: RoomMentions;
  readonly files: ReadonlyArray<string>;
}

/** The room a read is of. */
interface RoomReadRoom {
  readonly id: RoomId;
  readonly name: string;
  readonly archived: boolean;
}

/** The result of `read_room`. Its times are given in the operator's zone, as an envelope's. */
export interface RoomRead extends WriterClock {
  readonly room: RoomReadRoom;
  /** The words searched for; `null` for the room's newest messages. */
  readonly search: string | null;
  /** Oldest first. */
  readonly entries: ReadonlyArray<RoomReadEntry>;
  /** How many messages (matching ones, for a search) are older than those shown. */
  readonly earlier: number;
  /** Fewer messages are shown than the bot asked for, so that the result fits. */
  readonly cut: boolean;
}

/**
 * Why a post to a room went out nowhere: others wrote there since the bot
 * last saw it. It carries what the bot missed, as an envelope would.
 */
export interface RoomMovedOn extends WriterClock {
  readonly room: Omit<RoomReadRoom, "archived">;
  /** What the bot has not seen, oldest first: the newest that fit, at least the newest. */
  readonly entries: readonly [...Array<RoomReadEntry>, RoomReadEntry];
  /** How many messages it has not seen are older than those shown. */
  readonly omitted: number;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const writeEntry = (w: EnvelopeWriter, entry: RoomReadEntry): void => {
  const common: Attributes = [
    ["at", w.time(entry.at)],
    ["to", mentionsOf(entry.mentions)],
    // One attribute per file: a name may hold any character, a comma too.
    ...entry.files.map((name, index): readonly [string, string] => [`file-${index + 1}`, name]),
  ];
  const { author } = entry;
  switch (author.type) {
    case "user":
      w.block("message", [["from", "user"], ["name", author.name], ...common], entry.text);
      return;
    case "you":
      w.data([["source", "room"], ["from", "you"], ...common], entry.text);
      return;
    case "teammate":
      w.data(
        [
          ["source", "room"],
          ["from", author.teammate.name],
          ["from-id", author.teammate.id],
          ["title", titleOf(author.teammate)],
          ...common,
        ],
        entry.text,
      );
      return;
  }
};

const roomTag = (w: EnvelopeWriter, room: RoomReadRoom | RoomMovedOn["room"], extra: Attributes) =>
  w.empty("room", [["id", room.id], ["name", room.name], ...extra]);

const writeRead = (read: RoomRead, nonce: string) => {
  const w = new EnvelopeWriter(nonce, read);
  roomTag(w, read.room, [
    ["archived", read.room.archived ? "true" : null],
    ["search", read.search],
  ]);
  if (read.entries.length === 0) {
    w.line(
      read.search === null ? "The room has no messages yet." : "No message in the room matches.",
    );
  } else {
    w.line(
      `${read.search === null ? "The room's newest messages" : "The newest messages that match"}, oldest first; yours are from="you".`,
    );
    if (read.earlier > 0) {
      w.line(
        `${read.earlier} earlier ${read.search === null ? "" : "matching "}${plural(read.earlier, "message is", "messages are")} not shown.`,
      );
    }
    if (read.cut) {
      w.line("Fewer messages are shown than you asked for, so that this fits in one result.");
    }
    for (const entry of read.entries) writeEntry(w, entry);
  }
  return { text: `${w.lines.join("\n")}\n`, nonceUses: w.dataBlocks * 2 };
};

/** What a refused post's bot reads after the entries it missed. */
const ROOM_MOVED_ON_LINE =
  "Decide again with this in mind. Send your message again if it still holds, or adapt it. If what you missed changes what your user asked for, such as work already done or a question already answered, do not post: tell your user what changed. A post you send now goes out unless something newer arrives first.";

const writeMovedOn = (refusal: RoomMovedOn, nonce: string) => {
  const w = new EnvelopeWriter(nonce, refusal);
  w.line(
    "Nothing was sent: others wrote in the room since you last saw it. What you have not seen, oldest first:",
  );
  roomTag(w, refusal.room, []);
  if (refusal.omitted > 0) {
    w.line(
      `${refusal.omitted} earlier ${plural(refusal.omitted, "message", "messages")} you have not seen ${plural(refusal.omitted, "is", "are")} left out; the newest follow.`,
    );
  }
  for (const entry of refusal.entries) writeEntry(w, entry);
  w.line(ROOM_MOVED_ON_LINE);
  return { text: `${w.lines.join("\n")}\n`, nonceUses: w.dataBlocks * 2 };
};

const SIZING_NONCE = "0".repeat(NONCE_BYTES * 2);

/** Whether a read renders within {@link ROOM_READ_LIMIT}. */
export const roomReadFits = (read: RoomRead): boolean =>
  writeRead(read, SIZING_NONCE).text.length <= ROOM_READ_LIMIT;

/** Whether a refusal renders within {@link ROOM_READ_LIMIT}. */
export const roomMovedOnFits = (refusal: RoomMovedOn): boolean =>
  writeMovedOn(refusal, SIZING_NONCE).text.length <= ROOM_READ_LIMIT;

/** A read with a given nonce, twelve lowercase hex characters: for fixed renders only. */
export const renderRoomReadWithNonce = (read: RoomRead, nonce: string): string =>
  writeRead(read, nonce).text;

/** A refusal with a given nonce, twelve lowercase hex characters: for fixed renders only. */
export const renderRoomMovedOnWithNonce = (refusal: RoomMovedOn, nonce: string): string =>
  writeMovedOn(refusal, nonce).text;

/** A read as the bot reads it, with a nonce no content quotes. */
export const renderRoomRead = (
  read: RoomRead,
): Effect.Effect<string, never, SecureRandom.SecureRandom> =>
  withFreshNonce((nonce) => writeRead(read, nonce));

/** A refused post as the bot reads it, with a nonce no content quotes. */
export const renderRoomMovedOn = (
  refusal: RoomMovedOn,
): Effect.Effect<string, never, SecureRandom.SecureRandom> =>
  withFreshNonce((nonce) => writeMovedOn(refusal, nonce));
