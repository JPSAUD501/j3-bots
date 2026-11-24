// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  Entry,
  HandoffEntry,
  MessageEntry,
  NoticeEntry,
  RoutineChangeEntry,
  RoutineId,
  WorkFoldEntry,
} from "@j3-bots/contracts";

/** A notice of one kind, with its notice narrowed to that kind. */
type NoticeOf<Tag extends NoticeEntry["notice"]["_tag"]> = NoticeEntry & {
  readonly notice: Extract<NoticeEntry["notice"], { readonly _tag: Tag }>;
};

/** Routine changes of one kind by one author, one per routine, oldest first. */
export type RoutineChanges = readonly [RoutineChangeEntry, ...RoutineChangeEntry[]];

/**
 * Something that happened, which the timeline reports in one quiet line
 * rather than a card: nothing in it waits on the operator. What the operator
 * must answer, allow, give or sign in to stays a card, and so does a notice
 * of something that stopped, which may offer Try again.
 *
 * - `handoff`: a message between this bot and a teammate, either way; the
 *   line opens it in full.
 * - `routines`: one routine, or several in a row, created or changed alike;
 *   the line opens the routine, or lists them (`joinEventLines`).
 * - `routine-paused`: J3 Bots paused a routine it could not read; the line
 *   opens it, to be edited.
 * - `operator-named`: a bot saved the name the operator asked to be called by.
 */
export type EventLine =
  | {
      readonly _tag: "handoff";
      /** The other bot. */
      readonly peer: BotId;
      readonly entry: HandoffEntry;
    }
  | { readonly _tag: "routines"; readonly changes: RoutineChanges }
  | { readonly _tag: "routine-paused"; readonly entry: NoticeOf<"routine-paused"> }
  | { readonly _tag: "operator-named"; readonly entry: NoticeOf<"operator-named"> };

/** Every entry that is neither a message nor a turn's work. */
export type NonMessageEntry = Exclude<Entry, MessageEntry | WorkFoldEntry>;

/** What the bot asks of the operator, or a notice of something that stopped: drawn as a card. */
export type CardEntry = Exclude<NonMessageEntry, HandoffEntry | RoutineChangeEntry>;

/** The other bot of a teammate message: the recipient of one sent, the sender of one received. */
export function handoffPeer(entry: HandoffEntry): BotId {
  return entry.direction === "sent" ? entry.recipientId : entry.author.botId;
}

/**
 * A teammate message as a line of the conversation it is in: one line each,
 * joined to none. Kept apart and small, since messages between bots are to
 * move into a conversation of their own, which replaces this.
 */
function handoffLine(entry: HandoffEntry): EventLine {
  return { _tag: "handoff", peer: handoffPeer(entry), entry };
}

/** How an entry that is neither a message nor a turn's work is shown: in a line, or as a card. */
export type EntryPlace =
  | { readonly _tag: "line"; readonly line: EventLine }
  | { readonly _tag: "card"; readonly entry: CardEntry };

export function placeOf(entry: NonMessageEntry): EntryPlace {
  switch (entry._tag) {
    case "handoff":
      return { _tag: "line", line: handoffLine(entry) };
    case "routine-change":
      return { _tag: "line", line: { _tag: "routines", changes: [entry] } };
    case "notice": {
      const { notice } = entry;
      if (notice._tag === "routine-paused")
        return { _tag: "line", line: { _tag: "routine-paused", entry: { ...entry, notice } } };
      if (notice._tag === "operator-named")
        return { _tag: "line", line: { _tag: "operator-named", entry: { ...entry, notice } } };
      return { _tag: "card", entry };
    }
    default:
      return { _tag: "card", entry };
  }
}

const sameAuthor = (a: RoutineChangeEntry, b: RoutineChangeEntry) =>
  a.author._tag === b.author._tag &&
  (a.author._tag !== "bot" || (b.author._tag === "bot" && a.author.botId === b.author.botId));

/**
 * Routine changes, with `next` joined to them, or null when it starts a line
 * of its own. Two ways join, both by the same author:
 *
 * - An edit folds into the change before it when that one created or edited
 *   the same routine: a bot setting up a routine leaves one line, not one for
 *   every save. The folded change names the routine as the edit saved it, and
 *   still reads as created when it began with the creation.
 * - A change of another routine, of the same kind as those before it, joins
 *   them: "3 routines created".
 */
function joinRoutines(changes: RoutineChanges, next: RoutineChangeEntry): RoutineChanges | null {
  const [first] = changes;
  const last = changes[changes.length - 1] ?? first;
  if (!sameAuthor(first, next)) return null;
  const folds =
    next.change === "updated" &&
    (last.change === "created" || last.change === "updated") &&
    last.routineId === next.routineId;
  if (folds) {
    const folded = { ...next, change: last.change };
    return changes.length === 1 ? [folded] : [first, ...changes.slice(1, -1), folded];
  }
  const joins =
    next.change === first.change && !changes.some((change) => change.routineId === next.routineId);
  return joins ? [...changes, next] : null;
}

/**
 * The line `next` makes together with the line just before it, or null when
 * they stay two lines. Only routine changes join (`joinRoutines`); anything
 * between two lines, a time included, keeps them apart.
 */
export function joinEventLines(last: EventLine, next: EventLine): EventLine | null {
  if (last._tag !== "routines" || next._tag !== "routines") return null;
  const joined = next.changes.reduce<RoutineChanges | null>(
    (changes, change) => (changes === null ? null : joinRoutines(changes, change)),
    last.changes,
  );
  return joined === null ? null : { _tag: "routines", changes: joined };
}

/** The newest entry a line tells: the one that keeps its place and that reading it reads through. */
export function latestOfLine(line: EventLine): NonMessageEntry {
  switch (line._tag) {
    case "routines":
      return line.changes.reduce((latest, change) =>
        change.order > latest.order ? change : latest,
      );
    case "handoff":
    case "routine-paused":
    case "operator-named":
      return line.entry;
  }
}

/**
 * What tapping a line opens: the message in full; the routine; the routines
 * of a line that tells several, to pick one; or nothing, for a line with
 * nothing more to show, such as a deleted routine's.
 */
export type EventLineOpens =
  | { readonly _tag: "message"; readonly peer: BotId; readonly entry: HandoffEntry }
  | { readonly _tag: "routine"; readonly routineId: RoutineId }
  | { readonly _tag: "routines"; readonly changes: RoutineChanges }
  | null;

export function eventLineOpens(line: EventLine): EventLineOpens {
  switch (line._tag) {
    case "handoff":
      return { _tag: "message", peer: line.peer, entry: line.entry };
    case "routines": {
      const [only, ...rest] = line.changes;
      if (rest.length > 0) return { _tag: "routines", changes: line.changes };
      return only.change === "deleted" ? null : { _tag: "routine", routineId: only.routineId };
    }
    case "routine-paused":
      return { _tag: "routine", routineId: line.entry.notice.routineId };
    case "operator-named":
      return null;
  }
}
