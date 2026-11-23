// SPDX-License-Identifier: AGPL-3.0-or-later
import { compareVersions } from "@j3-bots/release";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { flushFolder, replaceFileDurably } from "../files.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { SnapshotRelease } from "../install/snapshot.ts";

// What a home records of the releases that ran on it, and what that lets a
// host start next (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md):
//
//   <home>/state/runtime.json     RuntimeRecord
//
// It names the release the home's data was last handed to, and whether that
// was a rollback, from which release: a transition writes it once it ends
// (with a server to start, once that server is ready), a rollback once the
// snapshot is back and the old release's server, if one, is ready, and a
// host once a server it started as it is became ready (`recordReady`). From
// the snapshot until a transition ends, it also names the transition under
// way (`pending`), so one cut off is carried on with the snapshot it took, or
// rolled back to it, never followed by a new one of data the new release may
// have migrated. Every write replaces the file whole and flushes it. A host
// about to start a release asks `decideStart` first.

/** The record's own format: a release that changes it incompatibly writes another. */
const RECORD_SCHEMA = 1;

/** A transition from its snapshot until it ends: the releases, and the snapshot's folder name. */
const PendingTransition = Schema.Struct({
  from: SnapshotRelease,
  to: SnapshotRelease,
  snapshot: Schema.String,
});
export type PendingTransition = typeof PendingTransition.Type;

const RuntimeRecord = Schema.Struct({
  schema: Schema.Literal(RECORD_SCHEMA),
  /** The release the home's data was last handed to. */
  version: Schema.String,
  readyAt: Schema.DateTimeUtc,
  /** Present when that was a rollback: the release that failed, rolled back from. */
  rollback: Schema.optionalKey(Schema.Struct({ from: Schema.String })),
  /** A transition from `version` that has not ended yet. */
  pending: Schema.optionalKey(PendingTransition),
});
export type RuntimeRecord = typeof RuntimeRecord.Type;

const RuntimeRecordJson = Schema.fromJsonString(Schema.toCodecJson(RuntimeRecord));

/** What a home's record says, as `readRuntimeRecord` finds it. */
export type RecordedRuntime =
  /** No record: no release that records one ran on the home yet. */
  | { readonly _tag: "none" }
  /** A record this release cannot read: a newer release's format, or a damaged file. */
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "recorded"; readonly record: RuntimeRecord };

const recordFile = (path: Path.Path, home: string) =>
  path.join(home, HOME_ENTRIES.state, "runtime.json");

/** The record of `home`. A file that is there but cannot be read is `unreadable`, never `none`. */
export const readRuntimeRecord = Effect.fn("transition.readRuntimeRecord")(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = recordFile(path, home);
  const read = yield* Effect.result(fs.readFileString(file));
  if (read._tag === "Failure") {
    return read.failure.reason._tag === "NotFound"
      ? ({ _tag: "none" } satisfies RecordedRuntime)
      : ({ _tag: "unreadable" } satisfies RecordedRuntime);
  }
  return yield* Schema.decodeEffect(RuntimeRecordJson)(read.success).pipe(
    Effect.map((record): RecordedRuntime => ({ _tag: "recorded", record })),
    Effect.orElseSucceed((): RecordedRuntime => ({ _tag: "unreadable" })),
  );
});

/** Replaces the record of `home` with `record`, whole and flushed. */
const writeRecord = Effect.fn("transition.writeRecord")(function* (
  home: string,
  record: RuntimeRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = recordFile(path, home);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
  yield* replaceFileDurably(file, yield* Schema.encodeEffect(RuntimeRecordJson)(record), 0o600);
});

/** The record of `home` when it names `version` and can be read. */
const recordOf = Effect.fnUntraced(function* (home: string, version: string) {
  const read = yield* readRuntimeRecord(home);
  return read._tag === "recorded" && read.record.version === version
    ? Option.some(read.record)
    : Option.none<RuntimeRecord>();
});

/**
 * Records, before the new release starts, the transition from `from` to `to`
 * with the snapshot in the folder named `snapshot`: `from` is what ran on the
 * data the snapshot holds.
 */
export const recordPending = Effect.fn("transition.recordPending")(function* (
  home: string,
  pending: PendingTransition,
) {
  const kept = yield* recordOf(home, pending.from.version);
  yield* writeRecord(home, {
    schema: RECORD_SCHEMA,
    version: pending.from.version,
    readyAt: Option.isSome(kept) ? kept.value.readyAt : yield* DateTime.now,
    ...(Option.isSome(kept) && kept.value.rollback !== undefined
      ? { rollback: kept.value.rollback }
      : {}),
    pending,
  });
});

/**
 * Records that `home`'s data is handed to `version` at the end of a
 * transition, by a rollback from `rollbackFrom` if one: the transition is no
 * longer pending.
 */
export const recordTransitioned = Effect.fn("transition.recordTransitioned")(function* (
  home: string,
  version: string,
  rollbackFrom: Option.Option<string>,
) {
  yield* writeRecord(home, {
    schema: RECORD_SCHEMA,
    version,
    readyAt: yield* DateTime.now,
    ...Option.match(rollbackFrom, {
      onNone: () => ({}),
      onSome: (from) => ({ rollback: { from } }),
    }),
  });
});

/**
 * Records that the server of `version` became ready on `home` outside a
 * transition: what a host does once a release `decideStart` let start as it
 * is answers ready, so the next release to start on the home is a change. A
 * rollback recorded for `version` stays recorded, so the release it rolled
 * back from is still not tried again by itself.
 */
export const recordReady = Effect.fn("transition.recordReady")(function* (
  home: string,
  version: string,
) {
  const kept = yield* recordOf(home, version);
  yield* writeRecord(home, {
    schema: RECORD_SCHEMA,
    version,
    readyAt: yield* DateTime.now,
    ...(Option.isSome(kept) && kept.value.rollback !== undefined
      ? { rollback: kept.value.rollback }
      : {}),
  });
});

/**
 * The way out of an `unreadable` record, which only the person may take,
 * never a host by itself: moves it aside, to `runtime.json.unreadable-<ms>`
 * beside it, where it is kept. The next start then finds no record and starts
 * the release as it is, and J3 Bots' database still refuses data a newer
 * release migrated, naming what it does not know.
 */
export const setAsideRecord = Effect.fn("transition.setAsideRecord")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = recordFile(path, home);
  const now = yield* DateTime.now;
  yield* fs.rename(file, `${file}.unreadable-${now.epochMilliseconds}`);
  yield* flushFolder(path.dirname(file));
});

/**
 * What a host may do about starting a release on a home:
 *
 * - `start`: the home's data is that release's own; start it as it is, and
 *   `recordReady` once it answers ready. For the release a rollback that has
 *   not finished ends on, `rollBack` is what starts it, since it also
 *   finishes the rollback.
 * - `snapshot-then-start`: a newer release than the one recorded; start it
 *   through a transition, which takes a snapshot first and rolls back if it
 *   never becomes ready. When a transition was cut off, it carries that one
 *   on with its snapshot if it is to the same release, and otherwise rolls
 *   it back first.
 * - `refuse-rolled-back`: the release a rollback was made from, the last
 *   time; start the recorded one instead. A host starts it again only when
 *   the person asks, through a transition, or once a newer one arrives.
 * - `refuse-downgrade`: an older release than the one recorded, whose
 *   runtime is kept: start the recorded one instead. Only a rollback a
 *   transition makes starts an older release, on the snapshot it put back.
 * - `refuse-unknown-schema`: nothing on this computer is known to read the
 *   home's data with that release: a record it cannot read (the person may
 *   set it aside: `setAsideRecord`), a newer release recorded whose runtime
 *   is not kept (an older app installed by hand), a version that cannot be
 *   ordered, a release no newer than the one a transition cut off started
 *   from, or a rollback that has not finished to another release.
 */
export type StartDecision =
  | "start"
  | "snapshot-then-start"
  | "refuse-rolled-back"
  | "refuse-downgrade"
  | "refuse-unknown-schema";

/** What `decideStart` decides from. */
export interface StartFacts {
  /** What the home's record says. */
  readonly recorded: RecordedRuntime;
  /** The release about to start. */
  readonly starting: string;
  /** The releases whose runtime is kept on this computer, ready to start. */
  readonly kept: ReadonlyArray<string>;
  /**
   * The release a rollback of the home ends on, while it has not finished
   * (its snapshot's mark): its data is that release's, put back part way.
   */
  readonly rollingBackTo: Option.Option<string>;
}

/** Whether `starting` sorts after `than`; none when the two cannot be ordered, two builds of one version included. */
const isNewer = (starting: string, than: string) =>
  Option.flatMap(compareVersions(starting, than), (order) =>
    order === 0 ? Option.none() : Option.some(order > 0),
  );

/** Whether `facts.starting` may start on the home, and how: see `StartDecision`. */
export const decideStart = (facts: StartFacts): StartDecision => {
  const { recorded, starting, kept, rollingBackTo } = facts;
  if (Option.isSome(rollingBackTo)) {
    // A rollback this core made starts its own release on the snapshot it puts back.
    return rollingBackTo.value === starting ? "start" : "refuse-unknown-schema";
  }
  switch (recorded._tag) {
    case "none":
      return "start";
    case "unreadable":
      return "refuse-unknown-schema";
    case "recorded":
      break;
  }
  const { version, rollback, pending } = recorded.record;
  if (pending !== undefined) {
    // The data is the one `pending.from` ran on, or what `pending.to` migrated
    // it to. A transition to `pending.to` carries the cut-off one on; one to
    // another release rolls it back to `pending.from` first, so a release
    // newer than that starts on that release's data.
    return Option.getOrElse(isNewer(starting, pending.from.version), () => false)
      ? "snapshot-then-start"
      : "refuse-unknown-schema";
  }
  if (version === starting) return "start";
  if (rollback?.from === starting) return "refuse-rolled-back";
  const newer = isNewer(starting, version);
  if (Option.isNone(newer)) return "refuse-unknown-schema";
  if (newer.value) return "snapshot-then-start";
  return kept.includes(version) ? "refuse-downgrade" : "refuse-unknown-schema";
};
