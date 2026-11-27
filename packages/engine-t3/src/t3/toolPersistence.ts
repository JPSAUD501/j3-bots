// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

// Whether a live dynamic tool runs on purpose, which decides how the
// engine's stop counts it (`Translate.ts`, `toolWork`). The stream drops the
// mark from an input above 16 KiB, so the adapter reads such an input again,
// as the item alone, which the engine cuts at 256 KiB. Reads that fail back
// off. A tool whose cut input leaves the mark unknown, or that no read
// decides in a bounded number of tries, is undecidable: the engine's own
// projection of its pending work decides it where it matters, when a
// `synchronized` event reports the session's background work
// (`Translate.ts`, `workInShell`).

/**
 * What the input of a dynamic tool the stream summarized says of its
 * persistence. `persistent`: the agent keeps it running on purpose, and it
 * never counts as pending. `transient`: it counts as pending while it runs.
 * `undecidable`: no read of the item returned enough of it, because the
 * engine cut it where the mark may be, or reading it failed too many times.
 */
export type ToolPersistence = "persistent" | "transient" | "undecidable";

/** The engine's test of a dynamic tool's input (**Read**, `isPersistentDynamicToolInput`). */
export const hasPersistentFlag = (input: unknown) =>
  Predicate.hasProperty(input, "persistent") && input.persistent === true;

/**
 * What `getTurnItem` ends a dynamic tool input with when it cut it short.
 * **Read** at `bc0f04d`, `WireProjection.ts`: it cuts a string input, or any
 * other input's JSON text, at 256 KiB (`MAX_ON_DEMAND_BYTES`, L30-31;
 * `boundDynamicValue`, L212-224; `projectTurnItemForDetail`, L255-266).
 */
const TRUNCATION_MARKER = "\n… output truncated for transport";

/** What `getTurnItem` returned for a tool. */
export type ItemRead =
  | { readonly _tag: "tool"; readonly input: unknown }
  /** The engine has no dynamic tool by that id any more. */
  | { readonly _tag: "not-a-tool" };

/**
 * The persistence a `getTurnItem` read shows. An item that is no longer a
 * dynamic tool is transient: nothing marks it persistent, and the engine's
 * stop goes by its own state. Nothing the engine sends says whether a cut
 * input was a string or an object: it cuts a string as it is and an object as
 * its JSON text, and the stream's summary is the first line of either
 * (`WireProjection.ts`, `summarizeDynamicValue`, L69-107). A cut text that
 * does not open with `{` was no object, so it carried no mark. One that does
 * may be either, so it tells nothing: a string that opens with an object's
 * text is transient, whatever that text says.
 */
export const persistenceOfRead = (read: ItemRead): ToolPersistence => {
  if (read._tag === "not-a-tool") return "transient";
  const { input } = read;
  if (typeof input === "string" && input.endsWith(TRUNCATION_MARKER)) {
    return input.startsWith("{") ? "undecidable" : "transient";
  }
  return hasPersistentFlag(input) ? "persistent" : "transient";
};

/**
 * How long after its `n`th failed read in a row a tool is read again: from 2
 * seconds, doubling up to 10 minutes, as the server's recovery backs off, so
 * an engine that fails the reads is not asked again on every catch-up.
 */
export const toolReadBackoff = (n: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 * 2 ** Math.max(0, n - 1)), Duration.minutes(10));

/** A tool whose persistence this many reads in a row failed to learn is undecidable. */
export const MAX_TOOL_READ_FAILURES = 5;

type ToolRead =
  | { readonly _tag: "settled"; readonly persistence: ToolPersistence }
  | { readonly _tag: "reading"; readonly failures: number }
  | { readonly _tag: "failed"; readonly failures: number; readonly retryAt: number };

/**
 * What the adapter learned of each summarized tool's persistence, by session,
 * shared by every stream of the session and by a Stop's reads, so a tool is
 * read once at a time, a failed read backs off, and the bound holds however
 * many readers ask.
 */
export interface ToolReads {
  /**
   * The tool's persistence: as settled before, or read now when no read of it
   * runs and its backoff passed. None while nothing is known. A read changes
   * only the entry it claimed: one forgotten meanwhile, and claimed again by
   * a later read, is that read's.
   */
  readonly resolve: <E, R>(
    sessionId: string,
    itemId: string,
    read: Effect.Effect<ToolPersistence, E, R>,
  ) => Effect.Effect<Option.Option<ToolPersistence>, never, R>;
  /**
   * Forgets each tool of the session that `ended` says a view of the session
   * at engine sequence `sequence` shows ended. Only the latest view prunes:
   * one older than a view that pruned before changes nothing, since a tool it
   * shows ended may have been reopened since. A view that does not have a
   * tool says nothing of it: a Stop's read may have claimed one no stream has
   * seen yet, and the session's end forgets what is left.
   */
  readonly prune: (
    sessionId: string,
    sequence: number,
    ended: (itemId: string) => boolean,
  ) => Effect.Effect<void>;
  /** Forgets every tool of a session that is gone. */
  readonly forget: (sessionId: string) => Effect.Effect<void>;
}

interface SessionReads {
  readonly tools: Map<string, ToolRead>;
  /** The engine sequence of the latest view that pruned. */
  prunedAt: number;
}

export const makeToolReads = (): ToolReads => {
  const sessions = new Map<string, SessionReads>();
  const readsOf = (sessionId: string) => {
    const found = sessions.get(sessionId);
    if (found !== undefined) return found;
    const created: SessionReads = { tools: new Map(), prunedAt: -1 };
    sessions.set(sessionId, created);
    return created;
  };

  const resolve = <E, R>(
    sessionId: string,
    itemId: string,
    read: Effect.Effect<ToolPersistence, E, R>,
  ): Effect.Effect<Option.Option<ToolPersistence>, never, R> =>
    Effect.gen(function* () {
      const reads = readsOf(sessionId).tools;
      const before = reads.get(itemId);
      if (before?._tag === "settled") return Option.some(before.persistence);
      if (before?._tag === "reading") return Option.none();
      if (before?._tag === "failed" && before.retryAt > (yield* Clock.currentTimeMillis)) {
        return Option.none();
      }
      const failures = before?.failures ?? 0;
      const claim: ToolRead = { _tag: "reading", failures };
      reads.set(itemId, claim);
      /** Replaces the claim, unless the tool was forgotten, or claimed again, meanwhile. */
      const update = (next: ToolRead | undefined) => {
        if (reads.get(itemId) !== claim) return;
        if (next === undefined) reads.delete(itemId);
        else reads.set(itemId, next);
      };
      const settle = (persistence: ToolPersistence) => {
        update({ _tag: "settled", persistence });
        return Option.some(persistence);
      };
      return yield* read.pipe(
        Effect.matchEffect({
          onSuccess: (persistence) => Effect.sync(() => settle(persistence)),
          onFailure: () =>
            Effect.map(Clock.currentTimeMillis, (now) => {
              const failed = failures + 1;
              if (failed >= MAX_TOOL_READ_FAILURES) return settle("undecidable");
              const retryAt = now + Duration.toMillis(toolReadBackoff(failed));
              update({ _tag: "failed", failures: failed, retryAt });
              return Option.none<ToolPersistence>();
            }),
        }),
        // An interrupted read, or a defect, learned nothing: the tool is as it was.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => update(before)),
        ),
      );
    });

  return {
    resolve,
    prune: (sessionId, sequence, ended) =>
      Effect.sync(() => {
        // A session forgotten meanwhile has nothing to prune: it is not made again.
        const reads = sessions.get(sessionId);
        if (reads === undefined || sequence < reads.prunedAt) return;
        reads.prunedAt = sequence;
        for (const itemId of reads.tools.keys()) if (ended(itemId)) reads.tools.delete(itemId);
      }),
    forget: (sessionId) => Effect.sync(() => void sessions.delete(sessionId)),
  };
};
