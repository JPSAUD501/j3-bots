// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoomChanges, RoomDraft } from "../stores/Details.ts";
import type { BotId, Room } from "@j3-bots/contracts";

/** How many bots a room holds, as the server checks. */
export const ROOM_MEMBERS = { min: 2, max: 6 } as const;
/**
 * Whether the operator can unarchive the room. A room of bots only takes no
 * members from them (decision 0103), so one that deleted bots left too small
 * stays archived; any other room gets what it lacks in the form.
 */
export const unarchivable = (room: Room): boolean =>
  room.botsOnly !== true || room.members.length >= ROOM_MEMBERS.min;

/** The longest room name the server takes. */
export const ROOM_NAME_MAX = 200;

/** The room form as the operator fills it. */
export interface RoomFormValues {
  readonly name: string;
  /** In the order picked, the order the room lists them in. */
  readonly members: ReadonlyArray<BotId>;
  /** Among the hidden conversations rather than in the roster's list. */
  readonly hidden: boolean;
}

export type RoomFormProblem = "name" | "members";

/**
 * What the form is for: a new room, with the bots it starts with, such as
 * two teammates' "Start a room with both"; changing one; or giving an
 * archived one what it needs back. `gone` when the room was deleted while
 * the form was open: the form stays, says so, and saves nothing.
 */
export type RoomFormMode =
  | { readonly _tag: "create"; readonly members?: ReadonlyArray<BotId> }
  | { readonly _tag: "edit" | "unarchive"; readonly room: Room; readonly gone: boolean };

/**
 * What a form is for, as a key: the same while it changes the same room the
 * same way, whatever the server says of that room meanwhile, and another for
 * anything else, so a form never carries what was typed over to another.
 */
export const roomFormTarget = (mode: RoomFormMode): string =>
  mode._tag === "create"
    ? `create:${(mode.members ?? []).join(",")}`
    : `${mode._tag}:${mode.room.id}`;

export const blankRoomForm: RoomFormValues = {
  name: "",
  members: [],
  hidden: false,
};

const sameOrder = (a: ReadonlyArray<BotId>, b: ReadonlyArray<BotId>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** The form filled from a room, to change it: what the server has. */
export const roomFormOf = (room: Room): RoomFormValues => ({
  name: room.name,
  members: room.members,
  hidden: room.hidden,
});

/**
 * Where a form starts: a new room empty but for the bots it was opened with,
 * in their order; a room the server has, as it has it.
 */
export const roomFormStart = (mode: RoomFormMode): RoomFormValues =>
  mode._tag === "create"
    ? { ...blankRoomForm, members: mode.members ?? [] }
    : roomFormOf(mode.room);

/** `values` without the bots that are no longer `present`. */
export function withoutDeleted(
  values: RoomFormValues,
  present: ReadonlySet<BotId>,
): RoomFormValues {
  if (values.members.every((id) => present.has(id))) return values;
  return { ...values, members: values.members.filter((id) => present.has(id)) };
}

/**
 * The form moved onto `room` as the server has it now, from `start`, the room
 * as the form last had it. A field takes the room's value only where the
 * server changed it and the operator did not: a name that reads the same as
 * before, only with other spaces around it, stays as typed until the server
 * changes it. The form then compares with the room as it is, so it sends
 * only what differs from it, but for whether it is hidden: once the operator
 * moved that switch, it is compared with the room as it was then
 * (`startAfterChange`), so their choice
 * is sent and recorded as theirs even when a bot set the same meanwhile
 * (decision 0050).
 */
export function followRoom(
  start: RoomFormValues,
  values: RoomFormValues,
  room: Room,
): { readonly start: RoomFormValues; readonly values: RoomFormValues } {
  const live = roomFormOf(room);
  const follows = (field: RoomField) =>
    !sameField(field, start, live) && sameField(field, start, values);
  const hiddenChosen = !sameField("hidden", start, values);
  return {
    start: hiddenChosen ? { ...live, hidden: start.hidden } : live,
    values: {
      name: follows("name") ? live.name : values.name,
      members: follows("members") ? live.members : values.members,
      hidden: follows("hidden") ? live.hidden : values.hidden,
    },
  };
}

/**
 * What the form compares with once the operator changes `values` to `next`.
 * Moving the hidden switch measures it against `room` as the server has it
 * then, as a bot's form does (`withHiddenEdit`): moving it back to that sends
 * nothing, and anything else is sent, also when a bot sets the same meanwhile
 * (`followRoom`).
 */
export const startAfterChange = (
  start: RoomFormValues,
  values: RoomFormValues,
  next: RoomFormValues,
  room: Room | null,
): RoomFormValues =>
  room === null || next.hidden === values.hidden ? start : { ...start, hidden: room.hidden };

/** `values` with `botId` in or out of the room. A seventh bot is not taken. */
export function withMember(values: RoomFormValues, botId: BotId, member: boolean): RoomFormValues {
  const has = values.members.includes(botId);
  if (member === has) return values;
  if (!member) return { ...values, members: values.members.filter((id) => id !== botId) };
  return values.members.length >= ROOM_MEMBERS.max
    ? values
    : { ...values, members: [...values.members, botId] };
}

/** What stops the form from being sent. */
function roomFormProblems(values: RoomFormValues): ReadonlySet<RoomFormProblem> {
  const problems = new Set<RoomFormProblem>();
  if (values.name.trim() === "") problems.add("name");
  const count = values.members.length;
  if (count < ROOM_MEMBERS.min || count > ROOM_MEMBERS.max) problems.add("members");
  return problems;
}

type Checked<A> =
  | { readonly _tag: "ready"; readonly value: A }
  | { readonly _tag: "invalid"; readonly problems: ReadonlySet<RoomFormProblem> };

/** The new room the form describes; a visible one says nothing of it, as the server's default. */
export function roomDraft(values: RoomFormValues): Checked<RoomDraft> {
  const problems = roomFormProblems(values);
  if (problems.size > 0) return { _tag: "invalid", problems };
  return {
    _tag: "ready",
    value: {
      name: values.name.trim(),
      members: values.members,
      ...(values.hidden ? { hidden: true } : {}),
    },
  };
}

type RoomField = "name" | "members" | "hidden";

/**
 * Whether `a` and `b` say the same of `field`, as the server reads it: the
 * name without the spaces around it, and the bots in their order.
 */
function sameField(field: RoomField, a: RoomFormValues, b: RoomFormValues): boolean {
  switch (field) {
    case "name":
      return a.name.trim() === b.name.trim();
    case "members":
      return sameOrder(a.members, b.members);
    case "hidden":
      return a.hidden === b.hidden;
  }
}

/** The fields where `values` say something else than `from`, as the server reads them. */
function changedFields(from: RoomFormValues, values: RoomFormValues): ReadonlySet<RoomField> {
  const changed = new Set<RoomField>();
  for (const field of ["name", "members", "hidden"] as const) {
    if (!sameField(field, from, values)) changed.add(field);
  }
  return changed;
}

/**
 * Whether `values` say the same as `opened`, where the form started: empty,
 * or the room as the server has it now. An edit the operator undid changes
 * nothing.
 */
export const sameRoomForm = (opened: RoomFormValues, values: RoomFormValues): boolean =>
  changedFields(opened, values).size === 0;

/**
 * What the form changes from `room`, the room as the server has it now, and
 * only that: a field changed elsewhere and left alone here follows the room
 * (`followRoom`), so it is not sent back.
 */
export function roomChanges(room: RoomFormValues, values: RoomFormValues): Checked<RoomChanges> {
  const problems = roomFormProblems(values);
  if (problems.size > 0) return { _tag: "invalid", problems };
  const changed = changedFields(room, values);
  return {
    _tag: "ready",
    value: {
      ...(changed.has("name") ? { name: values.name.trim() } : {}),
      ...(changed.has("members") ? { members: values.members } : {}),
      ...(changed.has("hidden") ? { hidden: values.hidden } : {}),
    },
  };
}
