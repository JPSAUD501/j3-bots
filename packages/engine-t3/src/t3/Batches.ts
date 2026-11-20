// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import type { SessionEvent } from "../events.ts";
import { EventCursor, type SessionId } from "../ids.ts";
import { copyMirror, copyView, type Mirror, type View } from "./Translate.ts";

// What an `events` stream emitted, kept so a cursor can resume it by replay.
// The engine replays entities as they are after a sequence, not what changed,
// so the events after a cursor follow only from what the stream had told at it
// (**Read** at `db51b67`, `ws.ts`, `subscribeThread`: replay coalesces the
// events after `afterSequence`).

/**
 * A batch's place: the engine sequence it was emitted at, and its part, which
 * counts the batches the stream emitted at that sequence before it. Only a
 * fetched file change emits a batch between two engine events.
 */
export interface BatchPlace {
  readonly sequence: number;
  readonly part: number;
}

/** One batch as it was emitted: the engine's state after it, what the stream had told, and its events. */
export interface Batch {
  readonly mirror: Mirror;
  readonly view: View;
  readonly events: ReadonlyArray<SessionEvent>;
}

/**
 * `<sequence>.<part>.<index>.<count>.<stream>`: the place of the batch the
 * event is in, the engine sequence being the engine's own position, the
 * event's place in that batch, and the stream that emitted it. A batch is what
 * one engine stream item, a snapshot, or a fetched file change turns into. The
 * stream names where the batch is kept: a resume replays from a kept batch,
 * which only the process that emitted it holds, and is a replacement otherwise.
 */
const CURSOR = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\.([0-9a-z]+)$/;

export const cursorFor = (place: BatchPlace, index: number, count: number, stream: string) =>
  EventCursor.make(`${place.sequence}.${place.part}.${index}.${count}.${stream}`);

const parseCursor = (cursor: EventCursor) => {
  const match = CURSOR.exec(cursor);
  if (match === null) return Option.none();
  const [, sequence, part, index, count, stream] = match;
  return sequence === undefined ||
    part === undefined ||
    index === undefined ||
    count === undefined ||
    stream === undefined
    ? Option.none()
    : Option.some({
        place: { sequence: Number(sequence), part: Number(part) },
        index: Number(index),
        count: Number(count),
        stream,
      });
};

const batchKey = (stream: string, place: BatchPlace) => `${stream}.${place.sequence}.${place.part}`;

/** Where a stream resumed from a cursor starts: what it tells first, and the state after it. */
export interface Resume {
  /** The events the stream emitted after the cursor at its engine sequence, in order. */
  readonly replay: ReadonlyArray<SessionEvent>;
  /** The engine's state after the last replayed batch, a copy the caller may change. */
  readonly mirror: Mirror;
  /** What the stream had told after the last replayed batch, a copy the caller may change. */
  readonly view: View;
  /** The engine sequence to subscribe after. */
  readonly sequence: number;
  /** The cursor of the last event told, the replayed ones included. */
  readonly lastCursor: EventCursor;
}

/**
 * The batches the streams of every session emitted, `limit` per session, the
 * newest last, and what each turn's end told of its hand-off, for as long as
 * the session lives. The hand-offs are one entry per ended turn, which the
 * engine's own record of the session holds too: the server rotates a session
 * after a threshold of runs (`docs/architecture/server.md`, Rotation), which
 * bounds both.
 */
export const makeBatches = (limit: number) => {
  const sessions = new Map<SessionId, Map<string, Batch>>();
  const handoffs = new Map<SessionId, Map<string, boolean>>();

  /** A stream of the session opens: what it emits is kept from now on. */
  const open = (sessionId: SessionId) => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, new Map());
    if (!handoffs.has(sessionId)) handoffs.set(sessionId, new Map());
  };

  /**
   * Keeps what a stream emitted. A session forgotten since the stream opened
   * keeps nothing: it is not made again.
   */
  const keep = (sessionId: SessionId, stream: string, place: BatchPlace, batch: Batch) => {
    const kept = sessions.get(sessionId);
    const told = handoffs.get(sessionId);
    if (kept === undefined || told === undefined) return;
    kept.set(batchKey(stream, place), batch);
    for (const oldest of kept.keys()) {
      if (kept.size <= limit) break;
      kept.delete(oldest);
    }
    for (const event of batch.events) {
      // A turn's end, as it was live, is the evidence.
      if (event._tag === "turn-finished") told.set(event.turnId, event.backgroundWork);
      // An end a replacement tells first, a stream having missed it, is
      // repeated as told then, never over what a live end told.
      if (event._tag === "replaced") {
        for (const turn of event.endedTurns) {
          if (!told.has(turn.turnId)) told.set(turn.turnId, turn.backgroundWork);
        }
      }
    }
  };

  /**
   * Whether each turn handed off, as its `turn-finished` told it, by turn id.
   * A hand-off is what the turn's end showed: work it started was still
   * running then. A replacement repeats it, also once the batches that told it
   * are gone, rather than recompute it from a roster the work has left since,
   * after it woke the session.
   */
  const toldHandoffs = (sessionId: SessionId): ReadonlyMap<string, boolean> =>
    handoffs.get(sessionId) ?? new Map();

  /**
   * Where a stream resumed from `after` starts, when the batch `after` is in
   * is kept. It tells the rest of that batch, then every later batch kept at
   * the same engine sequence: those came from file changes fetched after the
   * engine event, and the engine has nothing to replay for them. Later parts
   * are kept whenever the cursor's batch is, since the oldest go first.
   */
  const resume = (sessionId: SessionId, after: EventCursor | null): Resume | undefined => {
    if (after === null) return undefined;
    const kept = sessions.get(sessionId);
    const cursor = Option.getOrUndefined(parseCursor(after));
    if (kept === undefined || cursor === undefined) return undefined;
    const batch = kept.get(batchKey(cursor.stream, cursor.place));
    if (
      batch === undefined ||
      batch.events.length !== cursor.count ||
      cursor.index >= cursor.count
    ) {
      return undefined;
    }
    const replay = batch.events.slice(cursor.index + 1);
    let last = batch;
    for (let part = cursor.place.part + 1; ; part += 1) {
      const next = kept.get(batchKey(cursor.stream, { sequence: cursor.place.sequence, part }));
      if (next === undefined) break;
      replay.push(...next.events);
      last = next;
    }
    return {
      replay,
      mirror: copyMirror(last.mirror),
      view: copyView(last.view),
      sequence: cursor.place.sequence,
      lastCursor: replay.at(-1)?.cursor ?? after,
    };
  };

  /** Forgets a session's batches: nothing resumes its streams any more. */
  const forget = (sessionId: SessionId) => {
    sessions.delete(sessionId);
    handoffs.delete(sessionId);
  };

  return { open, keep, resume, toldHandoffs, forget };
};
