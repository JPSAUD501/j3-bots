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

export type RoomFormProblem = "name" | "members" | "host" | "hop-limit";

/** What reading the form takes beyond what the operator filled in. */
export interface RoomFormContext {
  /** The operator's primary bot, which hosts when it is a member and no host is picked. */
  readonly primaryId: BotId | null;
  /** The hop limit an empty field stands for; null until the settings are read. */
  readonly defaultHopLimit: number | null;
  /**
   * Whether the form chooses a host the operator has not picked: for a new
   * room, and for a room the server has with a host. A room the server has
   * without one waits for the operator to pick it.
   */
  readonly choosesHost: boolean;
}

/** How the form reads its values for `room`, the room as the server has it now, or null for a new one. */
export const roomFormContext = (
  room: Room | null,
  primaryId: BotId | null,
  defaultHopLimit: number | null,
): RoomFormContext => ({
  primaryId,
  defaultHopLimit,
  choosesHost: room === null || room.hostId !== null,
});

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
 * the host among it, and what they changed stays as they changed it. Changed
 * means what `roomChanges` would send: a name that differs only in spaces
 * around it, or a hop limit typed another way, is left alone. The form then
 * compares with the room as it is, so it sends only what differs from it.
 */
export function followRoom(
  start: RoomFormValues,
  values: RoomFormValues,
  room: Room,
  context: RoomFormContext,
): { readonly start: RoomFormValues; readonly values: RoomFormValues } {
  const live = roomFormOf(room);
  const changed = changedFields(start, values, context);
  return {
    start: live,
    values: {
      name: changed.has("name") ? values.name : live.name,
      members: changed.has("members") ? values.members : live.members,
      hostPick: changed.has("host") ? values.hostPick : live.hostPick,
      hopLimit: changed.has("hop-limit") ? values.hopLimit : live.hopLimit,
    },
  };
}

/**
 * Who hosts: the bot the operator picked while it is a member; else, where
 * the form chooses one, the primary bot when it is a member, else the first
 * member picked. Null while there is none.
 */
export function hostOf(values: RoomFormValues, context: RoomFormContext): BotId | null {
  const { members, hostPick } = values;
  if (hostPick !== null && members.includes(hostPick)) return hostPick;
  if (!context.choosesHost) return null;
  const { primaryId } = context;
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
 * What stops the form from being sent. A room the server has without a host
 * needs one picked, as the server does. An empty hop limit takes the default,
 * so it is a problem only where no default is known to set it back to.
 */
function roomFormProblems(
  values: RoomFormValues,
  context: RoomFormContext,
  emptyHopLimit: "omit" | "default",
): ReadonlySet<RoomFormProblem> {
  const problems = new Set<RoomFormProblem>();
  if (values.name.trim() === "") problems.add("name");
  const count = values.members.length;
  if (count < ROOM_MEMBERS.min || count > ROOM_MEMBERS.max) problems.add("members");
  // Without members there is no host to pick: the members are what is missing.
  if (count > 0 && hostOf(values, context) === null) problems.add("host");
  const hopLimit = hopLimitOf(values.hopLimit);
  if (
    hopLimit === "invalid" ||
    (hopLimit === null && emptyHopLimit === "default" && context.defaultHopLimit === null)
  ) {
    problems.add("hop-limit");
  }
  return problems;
}

type Checked<A> =
  | { readonly _tag: "ready"; readonly value: A }
  | { readonly _tag: "invalid"; readonly problems: ReadonlySet<RoomFormProblem> };

/** The new room the form describes. An empty hop limit is left to the server's default. */
export function roomDraft(values: RoomFormValues, context: RoomFormContext): Checked<RoomDraft> {
  const problems = roomFormProblems(values, context, "omit");
  const hostId = hostOf(values, context);
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

type RoomField = "name" | "members" | "host" | "hop-limit";

/**
 * The fields where `values` say something else than `from`, as the server
 * reads them: the name without the spaces around it, the bots in their
 * order, the host the form gives, and the hop limit as a number, an empty
 * one as the default.
 */
function changedFields(
  from: RoomFormValues,
  values: RoomFormValues,
  context: RoomFormContext,
): ReadonlySet<RoomField> {
  const changed = new Set<RoomField>();
  if (values.name.trim() !== from.name.trim()) changed.add("name");
  if (!sameOrder(values.members, from.members)) changed.add("members");
  if (hostOf(values, context) !== hostOf(from, context)) changed.add("host");
  const { defaultHopLimit } = context;
  if (resolvedHopLimit(values, defaultHopLimit) !== resolvedHopLimit(from, defaultHopLimit)) {
    changed.add("hop-limit");
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
  context: RoomFormContext,
): boolean => changedFields(opened, values, context).size === 0;

/**
 * What the form changes from `room`, the room as the server has it now, and
 * only that: a field changed elsewhere and left alone here follows the room
 * (`followRoom`), so it is not sent back. The host the form gives is sent
 * whenever the server's is not that one, as when the bot hosting it leaves
 * the room in this change. An empty hop limit sets it back to the default.
 */
export function roomChanges(
  room: RoomFormValues,
  values: RoomFormValues,
  context: RoomFormContext,
): Checked<RoomChanges> {
  const problems = roomFormProblems(values, context, "default");
  const hostId = hostOf(values, context);
  const hopLimit = resolvedHopLimit(values, context.defaultHopLimit);
  if (problems.size > 0 || hostId === null || hopLimit === null || hopLimit === "invalid") {
    return { _tag: "invalid", problems };
  }
  const changed = changedFields(room, values, context);
  return {
    _tag: "ready",
    value: {
      ...(changed.has("name") ? { name: values.name.trim() } : {}),
      ...(changed.has("members") ? { members: values.members } : {}),
      ...(changed.has("host") ? { hostId } : {}),
      ...(changed.has("hop-limit") ? { hopLimit } : {}),
    },
  };
}
