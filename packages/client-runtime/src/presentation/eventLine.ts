// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type Entry,
  type EventRoutineChangeEntry,
  type EntryId,
  type HandoffEntry,
  type MessageEntry,
  type NoticeEntry,
  type PairBotIds,
  pairBotIds,
  type RoomId,
  type RoutineChangeEntry,
  type RoutineId,
  type WorkFoldEntry,
} from "@j3-bots/contracts";

/** A notice of one kind, with its notice narrowed to that kind. */
type NoticeOf<Tag extends NoticeEntry["notice"]["_tag"]> = NoticeEntry & {
  readonly notice: Extract<NoticeEntry["notice"], { readonly _tag: Tag }>;
};

/**
 * A routine created or changed, as the routine lines tell it: one of J3
 * Bots' own triggers, or a connector's event, with a change both kinds share.
 */
export type RoutineChange =
  | RoutineChangeEntry
  | (EventRoutineChangeEntry & { readonly change: RoutineChangeEntry["change"] });

/** Routine changes of one kind by one author, one per routine, oldest first. */
export type RoutineChanges = readonly [RoutineChange, ...RoutineChange[]];

/**
 * Something that happened, which the timeline reports in one quiet line
 * rather than a card: nothing in it waits on the operator. What the operator
 * must answer, allow, give or sign in to stays a card, and so does a notice
 * of something that stopped, which may offer Try again.
 *
 * - `teammates`: messages between this bot and its teammates, either way,
 *   with nothing else between them (`TeammateRun`); the line opens the
 *   teammate conversation, or a chooser when there are several.
 * - `routines`: one routine, or several in a row, created or changed alike;
 *   the line opens the routine, or lists them (`joinEventLines`).
 * - `routine-paused`: J3 Bots paused a routine it could not read; the line
 *   opens it, to be edited.
 * - `event-routine`: J3 Bots stopped listening for a routine's event, or a
 *   routine on an event changed in a way this client does not know; the
 *   line opens the routine.
 * - `operator-named`: a bot saved the name the operator asked to be called by.
 * - `team`: a bot started a room on the operator's word (`room-started`), or
 *   made this bot for one (`made-for-room`); the line opens the room.
 */
export type EventLine =
  | { readonly _tag: "teammates"; readonly run: TeammateRun }
  | { readonly _tag: "routines"; readonly changes: RoutineChanges }
  | { readonly _tag: "routine-paused"; readonly entry: NoticeOf<"routine-paused"> }
  | { readonly _tag: "event-routine"; readonly entry: EventRoutineChangeEntry }
  | { readonly _tag: "operator-named"; readonly entry: NoticeOf<"operator-named"> }
  | { readonly _tag: "team"; readonly entry: NoticeOf<"room-started" | "made-for-room"> };

/** Every entry that is neither a message nor a turn's work. */
export type NonMessageEntry = Exclude<Entry, MessageEntry | WorkFoldEntry>;

/**
 * A routine with several steps that a bot made or changed (decision 0080):
 * drawn as its track at rest, which reads it back, rather than as a line.
 * Its trigger is one of J3 Bots' own, or a connector's event.
 */
export type TrackChangeEntry = (
  | RoutineChangeEntry
  | (EventRoutineChangeEntry & { readonly change: RoutineChangeEntry["change"] })
) & {
  readonly change: "created" | "updated";
  readonly steps: NonNullable<RoutineChangeEntry["steps"]>;
};

/**
 * What the bot asks of the operator, a notice of something that stopped, or
 * a routine's track: drawn as a card.
 */
export type CardEntry =
  | Exclude<NonMessageEntry, HandoffEntry | RoutineChangeEntry | EventRoutineChangeEntry>
  | TrackChangeEntry;

const isTrackChange = (entry: RoutineChange): entry is TrackChangeEntry =>
  entry.steps !== undefined && (entry.change === "created" || entry.change === "updated");

/** The other bot of a teammate message: the recipient of one sent, the sender of one received. */
export function handoffPeer(entry: HandoffEntry): BotId {
  return entry.direction === "sent" ? entry.recipientId : entry.author.botId;
}

/** The bot whose conversation a teammate message is in. */
const ownerOf = (entry: HandoffEntry): BotId =>
  entry.direction === "sent" ? entry.author.botId : entry.recipientId;

/** One teammate a run of messages was with, and where their conversation opens. */
export interface TeammateRunPair {
  readonly peer: BotId;
  readonly botIds: PairBotIds;
  /** The run's first message with this teammate: the conversation opens at it. */
  readonly first: EntryId;
  /** How many of the run's messages were with this teammate. */
  readonly count: number;
}

/**
 * Consecutive teammate messages in one bot's conversation, with nothing else
 * between them, which the conversation tells in one line ("Talked with Wren
 * · 3 messages").
 */
export interface TeammateRun {
  /** Oldest first. */
  readonly entries: readonly [HandoffEntry, ...HandoffEntry[]];
  /** Each teammate, in the order the run first met them. */
  readonly pairs: readonly [TeammateRunPair, ...TeammateRunPair[]];
  /** `sent` when the bot only wrote, `received` when it only heard, `both` otherwise. */
  readonly direction: "sent" | "received" | "both";
  /** Messages that never reached their teammate: `not-delivered` or `stopped`. */
  readonly undelivered: number;
}

/** The run `entries` make, oldest first. */
function teammateRun(entries: readonly [HandoffEntry, ...HandoffEntry[]]): TeammateRun {
  const [head, ...tail] = entries;
  const pairOf = (entry: HandoffEntry): TeammateRunPair => {
    const peer = handoffPeer(entry);
    return { peer, botIds: pairBotIds(ownerOf(entry), peer), first: entry.id, count: 1 };
  };
  const pairs: [TeammateRunPair, ...TeammateRunPair[]] = [pairOf(head)];
  for (const entry of tail) {
    const peer = handoffPeer(entry);
    const index = pairs.findIndex((pair) => pair.peer === peer);
    const known = pairs[index];
    if (known === undefined) pairs.push(pairOf(entry));
    else pairs[index] = { ...known, count: known.count + 1 };
  }
  const sent = entries.filter((entry) => entry.direction === "sent").length;
  return {
    entries,
    pairs,
    direction: sent === entries.length ? "sent" : sent === 0 ? "received" : "both",
    undelivered: entries.filter(
      (entry) => entry.state === "not-delivered" || entry.state === "stopped",
    ).length,
  };
}

/** How an entry that is neither a message nor a turn's work is shown: in a line, or as a card. */
export type EntryPlace =
  | { readonly _tag: "line"; readonly line: EventLine }
  | { readonly _tag: "card"; readonly entry: CardEntry };

export function placeOf(entry: NonMessageEntry): EntryPlace {
  switch (entry._tag) {
    case "handoff":
      return { _tag: "line", line: { _tag: "teammates", run: teammateRun([entry]) } };
    case "routine-change":
      return isTrackChange(entry)
        ? { _tag: "card", entry }
        : { _tag: "line", line: { _tag: "routines", changes: [entry] } };
    case "event-routine-change": {
      const { change } = entry;
      if (change === "stopped" || change === "unknown") {
        return { _tag: "line", line: { _tag: "event-routine", entry } };
      }
      const known = { ...entry, change };
      return isTrackChange(known)
        ? { _tag: "card", entry: known }
        : { _tag: "line", line: { _tag: "routines", changes: [known] } };
    }
    case "notice": {
      const { notice } = entry;
      if (notice._tag === "routine-paused")
        return { _tag: "line", line: { _tag: "routine-paused", entry: { ...entry, notice } } };
      if (notice._tag === "operator-named")
        return { _tag: "line", line: { _tag: "operator-named", entry: { ...entry, notice } } };
      if (notice._tag === "room-started" || notice._tag === "made-for-room")
        return { _tag: "line", line: { _tag: "team", entry: { ...entry, notice } } };
      return { _tag: "card", entry };
    }
    default:
      return { _tag: "card", entry };
  }
}

const sameAuthor = (a: RoutineChange, b: RoutineChange) =>
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
function joinRoutines(changes: RoutineChanges, next: RoutineChange): RoutineChanges | null {
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
 * they stay two lines. `quiet` says a time stands between them, a quiet
 * stretch long enough to be shown. Two runs of teammate messages join, across
 * a time too: an exchange told in one line says nothing of its pauses. Routine
 * changes join (`joinRoutines`) when no time stands between them. Anything
 * else between two lines keeps them apart.
 */
export function joinEventLines(last: EventLine, next: EventLine, quiet: boolean): EventLine | null {
  if (last._tag === "teammates" && next._tag === "teammates")
    return { _tag: "teammates", run: teammateRun([...last.run.entries, ...next.run.entries]) };
  if (last._tag !== "routines" || next._tag !== "routines" || quiet) return null;
  const joined = next.changes.reduce<RoutineChanges | null>(
    (changes, change) => (changes === null ? null : joinRoutines(changes, change)),
    last.changes,
  );
  return joined === null ? null : { _tag: "routines", changes: joined };
}

/** The newest entry a line tells: the one that keeps its place and that reading it reads through. */
export function latestOfLine(line: EventLine): NonMessageEntry {
  switch (line._tag) {
    case "teammates":
      return line.run.entries.reduce((latest, entry) =>
        entry.order > latest.order ? entry : latest,
      );
    case "routines":
      return line.changes.reduce((latest, change) =>
        change.order > latest.order ? change : latest,
      );
    case "routine-paused":
    case "event-routine":
    case "operator-named":
    case "team":
      return line.entry;
  }
}

/**
 * What tapping a line opens: the teammate conversation, at the run's first
 * message with that teammate (`TeammatePairs` reveals it); the teammates of a
 * run with several, to pick one; the routine; the routines of a line that
 * tells several, to pick one; the room a team line names; or nothing, for a
 * line with nothing more to show, such as a deleted routine's.
 */
export type EventLineOpens =
  | { readonly _tag: "pair"; readonly pair: TeammateRunPair }
  | { readonly _tag: "pairs"; readonly pairs: TeammateRun["pairs"] }
  | { readonly _tag: "routine"; readonly routineId: RoutineId }
  | { readonly _tag: "routines"; readonly changes: RoutineChanges }
  | { readonly _tag: "room"; readonly roomId: RoomId }
  | null;

/** Where a line is read, which decides whether a team line opens its room. */
export interface LineSetting {
  /** The room the timeline shows; null in a bot's conversation. */
  readonly room: RoomId | null;
  /** A room's name as it is now, or null once it is deleted (`PresentationContext.roomName`). */
  readonly roomName: (id: RoomId) => string | null;
}

export function eventLineOpens(line: EventLine, setting: LineSetting): EventLineOpens {
  switch (line._tag) {
    case "teammates": {
      const [only, ...rest] = line.run.pairs;
      return rest.length > 0
        ? { _tag: "pairs", pairs: line.run.pairs }
        : { _tag: "pair", pair: only };
    }
    case "routines": {
      const [only, ...rest] = line.changes;
      if (rest.length > 0) return { _tag: "routines", changes: line.changes };
      return only.change === "deleted" ? null : { _tag: "routine", routineId: only.routineId };
    }
    case "routine-paused":
      return { _tag: "routine", routineId: line.entry.notice.routineId };
    case "event-routine":
      return { _tag: "routine", routineId: line.entry.routineId };
    case "operator-named":
      return null;
    case "team": {
      // A deleted room has nothing to open, and the room's own line is already there.
      const { roomId } = line.entry.notice;
      return setting.roomName(roomId) === null || setting.room === roomId
        ? null
        : { _tag: "room", roomId };
    }
  }
}
