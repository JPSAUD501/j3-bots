// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment, QuestionEntry, RoomId } from "@j3-bots/contracts";
import { ENGINE_INPUT_LIMIT, engineInputLength } from "@j3-bots/engine-t3";
import type { AskAnswer, OperatorMessage, Wake } from "@j3-bots/prompts";
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
 * message's time, which gains its date once the day has changed, and a
 * room's name take well under this.
 */
const DISPATCH_VARIANCE = 1_000;

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

/** An operator's message as an envelope shows it. */
export const operatorMessage = (
  at: DateTime.Utc,
  text: string,
  files: ReadonlyArray<Attachment>,
): OperatorMessage => ({
  at,
  text,
  attachments: files.map((file) => ({
    name: file.name,
    path: inboxPath(file),
    mediaType: file.mediaType,
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
