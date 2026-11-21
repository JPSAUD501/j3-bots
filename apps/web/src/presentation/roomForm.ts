// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoomChanges, RoomDraft } from "@j3-bots/client-runtime";
import type { BotId, Room } from "@j3-bots/contracts";

/** How many bots a room holds, as the server checks. */
export const ROOM_MEMBERS = { min: 2, max: 6 } as const;
/** The longest room name the server takes. */
export const ROOM_NAME_MAX = 200;

/** The room form as the operator fills it. */
export interface RoomFormValues {
  readonly name: string;
  /** In the order picked, which is the order `@everyone` asks them in. */
  readonly members: ReadonlyArray<BotId>;
  /** The host the operator picked. It holds while it stays a member. */
  readonly hostPick: BotId | null;
  /** As typed. Empty means the default. */
  readonly hopLimit: string;
}

export type RoomFormProblem = "name" | "members" | "hop-limit";

/**
 * What the form is for: a new room, changing one, or giving an archived one
 * what it needs back. `gone` when the room was deleted while the form was
 * open: the form stays, says so, and saves nothing.
 */
export type RoomFormMode =
  | { readonly _tag: "create" }
  | { readonly _tag: "edit" | "unarchive"; readonly room: Room; readonly gone: boolean };

/**
 * What a form is for, as a key: the same while it changes the same room the
 * same way, whatever the server says of that room meanwhile, and another for
 * anything else, so a form never carries what was typed over to another.
 */
export const roomFormTarget = (mode: RoomFormMode): string =>
  mode._tag === "create" ? "create" : `${mode._tag}:${mode.room.id}`;

export const blankRoomForm: RoomFormValues = {
  name: "",
  members: [],
  hostPick: null,
  hopLimit: "",
};

const sameOrder = (a: ReadonlyArray<BotId>, b: ReadonlyArray<BotId>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The form filled from a room, to change it: what the server has, so an
 * archived room without a host has none picked.
 */
export const roomFormOf = (room: Room): RoomFormValues => ({
  name: room.name,
  members: room.members,
  hostPick: room.hostId,
  hopLimit: String(room.hopLimit),
});

/**
 * `values` without the bots that are no longer `present`. A host picked and
 * deleted gives way to `host`: for the form, the room's host as the server
 * last had it; for the room, none, as the server moves it to another host or
 * to none, which the form follows once the room says which.
 */
export function withoutDeleted(
  values: RoomFormValues,
  present: ReadonlySet<BotId>,
  host: BotId | null = null,
): RoomFormValues {
  const hostGone = values.hostPick !== null && !present.has(values.hostPick);
  if (values.members.every((id) => present.has(id)) && !hostGone) return values;
  return {
    ...values,
    members: values.members.filter((id) => present.has(id)),
    hostPick: hostGone ? host : values.hostPick,
  };
}

/**
 * The form moved onto `room` as the server has it now, from `start`, the room
 * as the form last had it: what the operator left alone follows the server,
 * the host among it, and what they changed stays as they changed it. The
 * form then compares with the room as it is, so it sends only what differs
 * from it.
 */
export function followRoom(
  start: RoomFormValues,
  values: RoomFormValues,
  room: Room,
): { readonly start: RoomFormValues; readonly values: RoomFormValues } {
  const live = roomFormOf(room);
  return {
    start: live,
    values: {
      name: values.name === start.name ? live.name : values.name,
      members: sameOrder(values.members, start.members) ? live.members : values.members,
      hostPick: values.hostPick === start.hostPick ? live.hostPick : values.hostPick,
      hopLimit: values.hopLimit === start.hopLimit ? live.hopLimit : values.hopLimit,
    },
  };
}

/**
 * Who hosts: the bot the operator picked while it is a member, else the
 * primary bot when it is one, else the first member picked.
 */
export function hostOf(values: RoomFormValues, primaryId: BotId | null): BotId | null {
  const { members, hostPick } = values;
  if (hostPick !== null && members.includes(hostPick)) return hostPick;
  if (primaryId !== null && members.includes(primaryId)) return primaryId;
  return members[0] ?? null;
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
export function roomDraft(values: RoomFormValues, primaryId: BotId | null): Checked<RoomDraft> {
  const problems = roomFormProblems(values, null, "omit");
  const hostId = hostOf(values, primaryId);
  const hopLimit = hopLimitOf(values.hopLimit);
  if (problems.size > 0 || hostId === null || hopLimit === "invalid") {
    return { _tag: "invalid", problems };
  }
  return {
    _tag: "ready",
    value: {
      name: values.name.trim(),
      members: values.members,
      hostId,
      ...(hopLimit === null ? {} : { hopLimit }),
    },
  };
}

/** The hop limit `values` give, with an empty one read as the default. */
const resolvedHopLimit = (values: RoomFormValues, defaultHopLimit: number | null) => {
  const typed = hopLimitOf(values.hopLimit);
  return typed === null ? defaultHopLimit : typed;
};

/**
 * Whether `values` say the same as `opened`, where the form started: empty,
 * or the room as the server has it now. The same name, bots in the same
 * order, the same host and the same hop limit. An edit the operator undid
 * changes nothing.
 */
export function sameRoomForm(
  opened: RoomFormValues,
  values: RoomFormValues,
  primaryId: BotId | null,
  defaultHopLimit: number | null,
): boolean {
  return (
    values.name.trim() === opened.name.trim() &&
    sameOrder(values.members, opened.members) &&
    hostOf(values, primaryId) === hostOf(opened, primaryId) &&
    resolvedHopLimit(values, defaultHopLimit) === resolvedHopLimit(opened, defaultHopLimit)
  );
}

/**
 * What the form changes from `room`, the room as the server has it now, and
 * only that: a field changed elsewhere and left alone here follows the room
 * (`followRoom`), so it is not sent back. The host the form shows is sent
 * whenever the server's is not that one, as when it has none, or the bot
 * hosting it leaves the room in this change. An empty hop limit sets it back
 * to the default.
 */
export function roomChanges(
  room: RoomFormValues,
  values: RoomFormValues,
  primaryId: BotId | null,
  defaultHopLimit: number | null,
): Checked<RoomChanges> {
  const problems = roomFormProblems(values, defaultHopLimit, "default");
  const hostId = hostOf(values, primaryId);
  const hopLimit = resolvedHopLimit(values, defaultHopLimit);
  if (problems.size > 0 || hostId === null || hopLimit === null || hopLimit === "invalid") {
    return { _tag: "invalid", problems };
  }
  const name = values.name.trim();
  return {
    _tag: "ready",
    value: {
      ...(name === room.name.trim() ? {} : { name }),
      ...(sameOrder(values.members, room.members) ? {} : { members: values.members }),
      ...(hostId === room.hostPick ? {} : { hostId }),
      ...(hopLimit === resolvedHopLimit(room, defaultHopLimit) ? {} : { hopLimit }),
    },
  };
}
