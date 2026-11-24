// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoomChanges, RoomDraft } from "../stores/Details.ts";
import type { BotId, Room } from "@j3-bots/contracts";

/** How many bots a room holds, as the server checks. */
export const ROOM_MEMBERS = { min: 2, max: 6 } as const;
/** The longest room name the server takes. */
export const ROOM_NAME_MAX = 200;

/** The room form as the operator fills it. */
export interface RoomFormValues {
  readonly name: string;
  /** In the order picked, which is the order members woken together answer in. */
  readonly members: ReadonlyArray<BotId>;
  /** As typed. Empty means the default. */
  readonly hopLimit: string;
}

export type RoomFormProblem = "name" | "members" | "hop-limit";

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
  hopLimit: "",
};

const sameOrder = (a: ReadonlyArray<BotId>, b: ReadonlyArray<BotId>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** The form filled from a room, to change it: what the server has. */
export const roomFormOf = (room: Room): RoomFormValues => ({
  name: room.name,
  members: room.members,
  hopLimit: String(room.hopLimit),
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
 * server changed it and the operator did not: a name or hop limit that reads
 * the same as before, only typed another way, stays as typed until the server
 * changes it. The form then compares with the room as it is, so it sends
 * only what differs from it.
 */
export function followRoom(
  start: RoomFormValues,
  values: RoomFormValues,
  room: Room,
  defaultHopLimit: number | null,
): { readonly start: RoomFormValues; readonly values: RoomFormValues } {
  const live = roomFormOf(room);
  const follows = (field: RoomField) =>
    !sameField(field, start, live, defaultHopLimit) &&
    sameField(field, start, values, defaultHopLimit);
  return {
    start: live,
    values: {
      name: follows("name") ? live.name : values.name,
      members: follows("members") ? live.members : values.members,
      hopLimit: follows("hop-limit") ? live.hopLimit : values.hopLimit,
    },
  };
}

/** `values` with `botId` in or out of the room. A seventh bot is not taken. */
export function withMember(values: RoomFormValues, botId: BotId, member: boolean): RoomFormValues {
  const has = values.members.includes(botId);
  if (member === has) return values;
  if (!member) return { ...values, members: values.members.filter((id) => id !== botId) };
  return values.members.length >= ROOM_MEMBERS.max
    ? values
    : { ...values, members: [...values.members, botId] };
}

/** The hop limit typed: a whole number from one up, null for the default, or `invalid`. */
function hopLimitOf(typed: string): number | null | "invalid" {
  const text = typed.trim();
  if (text === "") return null;
  if (!/^\d+$/u.test(text)) return "invalid";
  const value = Number(text);
  return value >= 1 && Number.isSafeInteger(value) ? value : "invalid";
}

/**
 * Where the hop limit's fewer and more buttons take it: one less and one more
 * than the number typed, or than the default while the field is empty. Null
 * where a button has nowhere to go: below one, or from a field that holds no
 * number with no default to count from.
 */
export function hopLimitSteps(
  typed: string,
  defaultHopLimit: number | null,
): { readonly fewer: number | null; readonly more: number | null } {
  const limit = hopLimitOf(typed);
  const from = limit === "invalid" ? null : (limit ?? defaultHopLimit);
  if (from === null) return { fewer: null, more: null };
  return {
    fewer: from > 1 ? from - 1 : null,
    more: Number.isSafeInteger(from + 1) ? from + 1 : null,
  };
}

/**
 * What stops the form from being sent. An empty hop limit takes the default,
 * so it is a problem only where no default is known to set it back to.
 */
function roomFormProblems(
  values: RoomFormValues,
  defaultHopLimit: number | null,
  emptyHopLimit: "omit" | "default",
): ReadonlySet<RoomFormProblem> {
  const problems = new Set<RoomFormProblem>();
  if (values.name.trim() === "") problems.add("name");
  const count = values.members.length;
  if (count < ROOM_MEMBERS.min || count > ROOM_MEMBERS.max) problems.add("members");
  const hopLimit = hopLimitOf(values.hopLimit);
  if (
    hopLimit === "invalid" ||
    (hopLimit === null && emptyHopLimit === "default" && defaultHopLimit === null)
  ) {
    problems.add("hop-limit");
  }
  return problems;
}

type Checked<A> =
  | { readonly _tag: "ready"; readonly value: A }
  | { readonly _tag: "invalid"; readonly problems: ReadonlySet<RoomFormProblem> };

/** The new room the form describes. An empty hop limit is left to the server's default. */
export function roomDraft(values: RoomFormValues): Checked<RoomDraft> {
  // The default is the server's to fill in, so it need not be known here.
  const problems = roomFormProblems(values, null, "omit");
  const hopLimit = hopLimitOf(values.hopLimit);
  if (problems.size > 0 || hopLimit === "invalid") return { _tag: "invalid", problems };
  return {
    _tag: "ready",
    value: {
      name: values.name.trim(),
      members: values.members,
      ...(hopLimit === null ? {} : { hopLimit }),
    },
  };
}

/** The hop limit `values` give, with an empty one read as the default. */
const resolvedHopLimit = (values: RoomFormValues, defaultHopLimit: number | null) => {
  const typed = hopLimitOf(values.hopLimit);
  return typed === null ? defaultHopLimit : typed;
};

type RoomField = "name" | "members" | "hop-limit";

/**
 * Whether `a` and `b` say the same of `field`, as the server reads it: the
 * name without the spaces around it, the bots in their order, and the hop
 * limit as a number, an empty one as the default.
 */
function sameField(
  field: RoomField,
  a: RoomFormValues,
  b: RoomFormValues,
  defaultHopLimit: number | null,
): boolean {
  switch (field) {
    case "name":
      return a.name.trim() === b.name.trim();
    case "members":
      return sameOrder(a.members, b.members);
    case "hop-limit":
      return resolvedHopLimit(a, defaultHopLimit) === resolvedHopLimit(b, defaultHopLimit);
  }
}

/** The fields where `values` say something else than `from`, as the server reads them. */
function changedFields(
  from: RoomFormValues,
  values: RoomFormValues,
  defaultHopLimit: number | null,
): ReadonlySet<RoomField> {
  const changed = new Set<RoomField>();
  for (const field of ["name", "members", "hop-limit"] as const) {
    if (!sameField(field, from, values, defaultHopLimit)) changed.add(field);
  }
  return changed;
}

/**
 * Whether `values` say the same as `opened`, where the form started: empty,
 * or the room as the server has it now. An edit the operator undid changes
 * nothing.
 */
export const sameRoomForm = (
  opened: RoomFormValues,
  values: RoomFormValues,
  defaultHopLimit: number | null,
): boolean => changedFields(opened, values, defaultHopLimit).size === 0;

/**
 * What the form changes from `room`, the room as the server has it now, and
 * only that: a field changed elsewhere and left alone here follows the room
 * (`followRoom`), so it is not sent back. An empty hop limit sets it back to
 * the default.
 */
export function roomChanges(
  room: RoomFormValues,
  values: RoomFormValues,
  defaultHopLimit: number | null,
): Checked<RoomChanges> {
  const problems = roomFormProblems(values, defaultHopLimit, "default");
  const hopLimit = resolvedHopLimit(values, defaultHopLimit);
  if (problems.size > 0 || hopLimit === null || hopLimit === "invalid") {
    return { _tag: "invalid", problems };
  }
  const changed = changedFields(room, values, defaultHopLimit);
  return {
    _tag: "ready",
    value: {
      ...(changed.has("name") ? { name: values.name.trim() } : {}),
      ...(changed.has("members") ? { members: values.members } : {}),
      ...(changed.has("hop-limit") ? { hopLimit } : {}),
    },
  };
}
