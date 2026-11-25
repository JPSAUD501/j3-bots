// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Attachment,
  BotId,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_ROOM_MEMBERS,
  PROFILE_LIMITS,
  type QuestionEntry,
  type RoomId,
} from "@j3-bots/contracts";
import { ENGINE_INPUT_LIMIT, engineInputLength } from "@j3-bots/engine-t3";
import type { AskAnswer, OperatorMessage, RoomWake, TeammateRef, Wake } from "@j3-bots/prompts";
import { renderWakeForSize } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Rooms } from "../rooms/Rooms.ts";
import type { SettingsStore } from "../settings/SettingsStore.ts";
import { inboxPath } from "./inbox.ts";

/**
 * The margin a writer of operator text into a wake (`message.send`,
 * `card.answer`) leaves under the engine's input limit when it checks that
 * text alone: what can render longer when the wake is dispatched later. The
 * wake's zone (an IANA name, at most about 30 characters), its weekday, the
 * message's time, which gains its date once the day has changed, take well
 * under this. What a room may change meanwhile (its name, members and their
 * names) is checked at its widest instead (`widestRoomHeader`).
 */
const DISPATCH_VARIANCE = 1_000;

/**
 * The most unseen room entries an envelope is built from: a member back after
 * a long absence is shown the newest, and told how many earlier ones it missed.
 * A post refused because the room moved on shows them the same way.
 */
export const ROOM_ENTRIES_READ = 200;

/**
 * The largest count in `[1, max]` for which `fits` holds, given that it holds
 * for 1 and, once it fails, fails for every larger count.
 */
export const longestFitting = (max: number, fits: (count: number) => boolean): number => {
  let low = 1;
  let high = max;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
};

/** Whether an envelope renders within the engine's input limit, less `reserve`. */
export const fitsEngine = (wake: Wake, reserve = 0): boolean =>
  engineInputLength(renderWakeForSize(wake)) <= ENGINE_INPUT_LIMIT - reserve;

/**
 * Whether a wake its writer is about to admit fits a dispatch alone, now and
 * when it is dispatched later. Every path that writes operator text into a
 * wake checks it before it commits, so the dispatcher never meets a wake it
 * cannot send.
 */
export const fitsAlone = (wake: Wake): boolean => fitsEngine(wake, DISPATCH_VARIANCE);

/**
 * Text of `length` characters that renders longest in an envelope: each
 * character is one the envelope escapes, into its longest entity.
 */
const widest = (length: number): string => '"'.repeat(length);

/** A room's name at its widest: a room can be renamed after text for it was accepted. */
export const WIDEST_ROOM_NAME = widest(MAX_LABEL_LENGTH);

/** A teammate as an envelope names it at its widest: a bot can be renamed meanwhile. */
export const widestTeammate = (id: BotId): TeammateRef => ({
  id,
  name: widest(PROFILE_LIMITS.name),
  title: widest(PROFILE_LIMITS.title),
});

/**
 * The room as an envelope names it at its widest: its name, as many members
 * as a room can have, and every name and id as long as they can be. A wake
 * for the room may be dispatched after the room was renamed, given members,
 * or its members renamed, so a writer of operator text into a
 * room's wake checks its size with this rather than the room as it is now.
 */
export const widestRoomHeader = (roomId: RoomId): RoomWake["room"] => {
  const member = widestTeammate(BotId.make(widest(MAX_ID_LENGTH)));
  return {
    id: roomId,
    name: WIDEST_ROOM_NAME,
    members: Array.from({ length: MAX_ROOM_MEMBERS }, () => member),
  };
};

/** The operator's zone, in which an envelope gives every time. */
export const operatorZone = (settings: SettingsStore["Service"]) =>
  Effect.map(settings.get, (now) =>
    Option.getOrElse(DateTime.zoneMakeNamed(now.timeZone), () =>
      DateTime.zoneMakeNamedUnsafe("UTC"),
    ),
  );

/** The name of the room an `ask` was asked for; `null` for the bot's own conversation. */
export const roomName = (rooms: Rooms["Service"], roomId: RoomId | null) =>
  roomId === null
    ? Effect.succeed(null)
    : Effect.map(
        rooms.find(roomId),
        Option.match({ onNone: () => null, onSome: (room) => room.name }),
      );

/**
 * An operator's message as an envelope shows it: each file where `offsets`
 * places it in the text, or, without them, after the text.
 */
export const operatorMessage = (
  at: DateTime.Utc,
  text: string,
  files: ReadonlyArray<Attachment>,
  offsets?: ReadonlyArray<number>,
): OperatorMessage => ({
  at,
  text,
  attachments: files.map((file, index) => ({
    name: file.name,
    path: inboxPath(file),
    mediaType: file.mediaType,
    offset: offsets?.[index] ?? null,
  })),
});

/**
 * The operator's response to an `ask` card as an envelope shows it: the
 * options chosen with the values the bot gave them, and the typed answer.
 * Anything but an answer reads as dismissed.
 */
export const askAnswer = (input: {
  readonly card: QuestionEntry;
  readonly status: QuestionEntry["status"];
  readonly values: Readonly<Record<string, string | null>>;
  readonly room: string | null;
}): AskAnswer => {
  const question = input.card.questions[0];
  const { status, values } = input;
  const response: AskAnswer["response"] =
    status._tag === "answered"
      ? {
          type: "answered",
          chosen: (status.answers[question.id]?.optionIds ?? []).flatMap((optionId) => {
            const option = question.options.find((candidate) => candidate.id === optionId);
            return option === undefined
              ? []
              : [{ label: option.label, value: values[optionId] ?? null }];
          }),
          text: status.answers[question.id]?.text ?? null,
        }
      : { type: "dismissed" };
  return { question: question.prompt, room: input.room, response };
};
