// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, BotId, Room } from "@j3-bots/contracts";
import { useState } from "react";
import { type IntentFailure, refusedWith } from "../intents/Actions.ts";
import {
  followRoom,
  ROOM_MEMBERS,
  roomChanges,
  roomDraft,
  type RoomFormMode,
  type RoomFormProblem,
  roomFormStart,
  type RoomFormValues,
  sameRoomForm,
  startAfterChange,
  withMember,
  withoutDeleted,
} from "../presentation/roomForm.ts";
import type { RoomChanges, RoomDraft } from "../stores/Details.ts";

/** What the form sends: a new room, or changes to the one it edits. */
export type RoomSubmission =
  | { readonly _tag: "create"; readonly draft: RoomDraft }
  | { readonly _tag: "update"; readonly changes: RoomChanges };

/**
 * Why the form says it did not save, apart from the bots, which are said
 * beside them: the room is gone, it was archived meanwhile, or the server
 * did not take it.
 */
export type RoomFormFailure = "gone" | "archived" | "create-failed" | "failed";

/**
 * What submitting did: nothing changed, so there was nothing to send; the
 * submission went to the server; or it was held, as while one is under way,
 * offline, with the room gone, or with something missing, which then shows.
 */
export type RoomFormSubmitted = "unchanged" | "sent" | "held";

export interface RoomForm {
  /** The room the form edits, as it last was; null for a new room. */
  readonly room: Room | null;
  readonly values: RoomFormValues;
  /** Changes what the form holds, unless a submission is under way. */
  readonly change: (next: RoomFormValues) => void;
  readonly toggleMember: (botId: BotId) => void;
  /** Every bot, by name, to pick from. */
  readonly choices: ReadonlyArray<Bot>;
  /** No bot can be added. */
  readonly full: boolean;
  /** What is missing, once the operator tried to send. */
  readonly problems: ReadonlySet<RoomFormProblem>;
  /** The server refused the bots picked. */
  readonly membersRefused: boolean;
  readonly failure: RoomFormFailure | null;
  /** Bots picked and then deleted elsewhere, by name. */
  readonly dropped: ReadonlyArray<string>;
  /** A submission is under way. */
  readonly busy: boolean;
  /** Whether Send does anything now. */
  readonly canSubmit: boolean;
  /** Whether the form holds what the operator changed and did not send. */
  readonly unsaved: boolean;
  /**
   * Sends what the form holds through `send`, which resolves with why it
   * failed, or null once the server has it.
   */
  readonly submit: (
    send: (submission: RoomSubmission) => Promise<IntentFailure | null>,
  ) => RoomFormSubmitted;
}

/**
 * A room's name, its bots and whether it is hidden, as a form holds them. What is
 * missing shows once the operator tries to send; a refusal keeps what was
 * typed. What the operator left alone follows the room as the server has it,
 * and a submission sends only what the form changes. A bot picked and deleted
 * meanwhile leaves the selection and is named in `dropped`; a room deleted
 * meanwhile saves nothing. Another target needs another form: mount it anew.
 */
export function useRoomForm(options: {
  readonly mode: RoomFormMode;
  /** Every bot the operator has; the same list while the bots stay the same. */
  readonly bots: ReadonlyArray<Bot>;
  /** Sending takes a connection to the server. */
  readonly connected: boolean;
  /** The language the bots are sorted in. */
  readonly locale: string;
  /** Where the form starts, for a gallery; the room as the server has it, or empty, otherwise. */
  readonly initial?: RoomFormValues | undefined;
  /** A failure to show from the start, for a gallery. */
  readonly initialFailure?: IntentFailure | undefined;
}): RoomForm {
  const { mode, bots, connected, locale } = options;
  const room = mode._tag === "create" ? null : mode.room;
  const gone = mode._tag !== "create" && mode.gone;
  // Where the form starts: the room as the server has it, or the bots it was opened with.
  const [start, setStart] = useState(() => options.initial ?? roomFormStart(mode));
  const [values, setValues] = useState(start);
  const [dropped, setDropped] = useState<ReadonlyArray<string>>([]);
  const [botsSeen, setBotsSeen] = useState(bots);
  const [roomSeen, setRoomSeen] = useState(room);
  if (botsSeen !== bots || roomSeen !== room) {
    let nextStart = start;
    let nextValues = values;
    if (botsSeen !== bots) {
      setBotsSeen(bots);
      const present = new Set<BotId>(bots.map((bot) => bot.id));
      // The server drops them from the room too, which the form follows once the room says so.
      nextStart = withoutDeleted(start, present);
      nextValues = withoutDeleted(values, present);
      const deleted = values.members.filter((id) => !present.has(id));
      if (deleted.length > 0) {
        const names = new Map(botsSeen.map((bot) => [bot.id, bot.profile.name]));
        setDropped([...dropped, ...deleted.flatMap((id) => names.get(id) ?? [])]);
      }
    }
    if (roomSeen !== room) {
      setRoomSeen(room);
      if (room !== null) {
        const followed = followRoom(nextStart, nextValues, room);
        nextStart = followed.start;
        nextValues = followed.values;
      }
    }
    setStart(nextStart);
    setValues(nextValues);
  }
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<IntentFailure | null>(options.initialFailure ?? null);
  // What is missing shows once the operator tried to send, and follows the form from then on.
  const [tried, setTried] = useState(false);

  const draft = room === null ? roomDraft(values) : null;
  const changes = room === null ? null : roomChanges(start, values);
  // What goes to the server, once nothing is missing.
  const submission: RoomSubmission | null =
    draft?._tag === "ready"
      ? { _tag: "create", draft: draft.value }
      : changes?._tag === "ready"
        ? {
            _tag: "update",
            changes:
              mode._tag === "unarchive" ? { ...changes.value, archived: false } : changes.value,
          }
        : null;
  const missing =
    draft?._tag === "invalid"
      ? draft.problems
      : changes?._tag === "invalid"
        ? changes.problems
        : null;
  const membersRefused = refusedWith(failure, "room-members");
  const canSubmit = !busy && connected && !gone;

  const change = (next: RoomFormValues) => {
    if (busy) return;
    setStart(startAfterChange(start, values, next, room));
    setValues(next);
    setFailure(null);
  };
  return {
    room,
    values,
    change,
    toggleMember: (botId) => change(withMember(values, botId, !values.members.includes(botId))),
    choices: bots.toSorted((a, b) => a.profile.name.localeCompare(b.profile.name, locale)),
    full: values.members.length >= ROOM_MEMBERS.max,
    problems: tried && missing !== null ? missing : new Set(),
    membersRefused,
    failure: gone
      ? "gone"
      : failure === null || membersRefused
        ? null
        : failure._tag === "refused" && failure.error._tag === "Conflict"
          ? "archived"
          : failure._tag === "refused" && failure.error._tag === "NotFound" && room !== null
            ? "gone"
            : room === null
              ? "create-failed"
              : "failed",
    dropped,
    busy,
    canSubmit,
    unsaved: !sameRoomForm(start, values),
    submit: (send) => {
      if (!canSubmit) return "held";
      setTried(true);
      if (submission === null) return "held";
      if (submission._tag === "update" && Object.keys(submission.changes).length === 0) {
        return "unchanged";
      }
      setBusy(true);
      setFailure(null);
      void send(submission).then((failed) => {
        setBusy(false);
        setFailure(failed);
      });
      return "sent";
    },
  };
}
