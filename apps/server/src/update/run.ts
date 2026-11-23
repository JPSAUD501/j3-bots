// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DeviceId, NonNegativeInt, ReleaseVersion, UpdateFailure } from "@j3-bots/contracts";
import { replaceFileDurably } from "../files.ts";
import { HOME_ENTRIES } from "../home/entries.ts";

// The update a client asked for, from the moment the server accepts it until
// a newer one replaces it:
//
//   <home>/state/update.json     UpdateRun
//
// The server writes it before it starts the update's unit; from then on only
// the update (`j3-bots update --run <id>`) writes it, stage by stage, and
// last with how it ended. It is in the home, not in the server's memory, so
// it outlives the restart the update makes: whichever release runs
// afterwards, the new one or the old one again, reads it and tells clients
// how the update ended. Every write replaces the file whole and flushes it.

/** The record's own format: a release that changes it incompatibly writes another. */
const RUN_SCHEMA = 1;

/** Where an update that has not ended is. */
export const RunStage = Schema.Union([
  /** Downloading the release: what has come so far, and its size once the download says. */
  Schema.TaggedStruct("downloading", {
    receivedBytes: NonNegativeInt,
    totalBytes: Schema.NullOr(NonNegativeInt),
  }),
  /** Checking the download against the release's signed checksums. */
  Schema.TaggedStruct("verifying", {}),
  /** Unpacking the release and fetching the engine it is pinned to. Nothing runs differently yet. */
  Schema.TaggedStruct("installing", {}),
  /** Stopping the service, copying the databases, starting the new release and waiting for it. */
  Schema.TaggedStruct("restarting", {}),
]);
export type RunStage = typeof RunStage.Type;

/** How an update ended: `UpdateOutcome`, with why when it did not end on the new release. */
export const RunOutcome = Schema.Union([
  /** The new release runs. */
  Schema.TaggedStruct("done", { at: Schema.DateTimeUtc }),
  /**
   * The new release did not become ready, or the update stopped before it
   * changed anything: the release before runs, on the data as it was.
   */
  Schema.TaggedStruct("rolled-back", {
    at: Schema.DateTimeUtc,
    reason: UpdateFailure,
    detail: Schema.String,
  }),
  /** Bringing the release before back failed too: `j3-bots update --rollback` finishes it. */
  Schema.TaggedStruct("failed", {
    at: Schema.DateTimeUtc,
    reason: UpdateFailure,
    detail: Schema.String,
  }),
]);
export type RunOutcome = typeof RunOutcome.Type;

export const UpdateRun = Schema.Struct({
  schema: Schema.Literal(RUN_SCHEMA),
  /** `update_…`; the update's unit is named after it. */
  id: Schema.String,
  /** The release that ran when it was asked for. */
  from: ReleaseVersion,
  /** The release it installs. */
  to: ReleaseVersion,
  /** The paired device that asked. */
  by: DeviceId,
  startedAt: Schema.DateTimeUtc,
  /** Where it is, while it has not ended. */
  stage: RunStage,
  /** How it ended, once it has. */
  outcome: Schema.optionalKey(RunOutcome),
});
export type UpdateRun = typeof UpdateRun.Type;

const UpdateRunJson = Schema.fromJsonString(Schema.toCodecJson(UpdateRun));

/** What the home's record says. */
export type RecordedRun =
  | { readonly _tag: "none" }
  /** A record this release cannot read: a newer release's format, or a damaged file. */
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "recorded"; readonly run: UpdateRun };

const runFile = (path: Path.Path, home: string) =>
  path.join(home, HOME_ENTRIES.state, "update.json");

/** The run recorded in `home`. */
export const readRun = Effect.fn("update.readRun")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = yield* Effect.result(fs.readFileString(runFile(path, home)));
  if (read._tag === "Failure") {
    return read.failure.reason._tag === "NotFound"
      ? ({ _tag: "none" } satisfies RecordedRun)
      : ({ _tag: "unreadable" } satisfies RecordedRun);
  }
  return yield* Schema.decodeEffect(UpdateRunJson)(read.success).pipe(
    Effect.map((run): RecordedRun => ({ _tag: "recorded", run })),
    Effect.orElseSucceed((): RecordedRun => ({ _tag: "unreadable" })),
  );
});

/** Replaces the record of `home` with `run`, durably, readable by this user only. */
export const writeRun = Effect.fn("update.writeRun")(function* (home: string, run: UpdateRun) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = runFile(path, home);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
  const json = yield* Schema.encodeEffect(UpdateRunJson)(run).pipe(Effect.orDie);
  yield* replaceFileDurably(file, `${json}\n`, 0o600);
});

/** A run that may still change: it has not ended. */
export const isUnderway = (run: UpdateRun) => run.outcome === undefined;

/** The run `id` in `home`, while it is underway: what only that run may change. */
const underway = Effect.fn("update.underway")(function* (home: string, id: string) {
  const recorded = yield* readRun(home);
  return recorded._tag === "recorded" && recorded.run.id === id && isUnderway(recorded.run)
    ? Option.some(recorded.run)
    : Option.none<UpdateRun>();
});

/** Moves run `id` to `stage`, while it is underway. */
export const advanceRun = Effect.fn("update.advanceRun")(function* (
  home: string,
  id: string,
  stage: RunStage,
) {
  const run = yield* underway(home, id);
  if (Option.isSome(run)) yield* writeRun(home, { ...run.value, stage });
});

/** How a run ended, less when. */
export type Ending =
  | { readonly _tag: "done" }
  | {
      readonly _tag: "rolled-back" | "failed";
      readonly reason: UpdateFailure;
      readonly detail: string;
    };

/** Ends run `id` with `ending`, while it is underway. */
export const endRun = Effect.fn("update.endRun")(function* (
  home: string,
  id: string,
  ending: Ending,
) {
  const run = yield* underway(home, id);
  if (Option.isNone(run)) return;
  yield* writeRun(home, { ...run.value, outcome: { ...ending, at: yield* DateTime.now } });
});
