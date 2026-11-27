// SPDX-License-Identifier: AGPL-3.0-or-later
import { countBucket, ReleaseVersion, type TelemetryEvent } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { ServerConfig } from "../config.ts";
import { readRun, type UpdateRun } from "../update/run.ts";
import { Telemetry, TelemetryConfig } from "./Telemetry.ts";
import { type TelemetryMarks, TelemetryStore } from "./TelemetryStore.ts";

// What the server tells of itself rather than of something someone did: that
// it started, that the install is in use today, and how an update ended.
// Each is told once: the marks in `TelemetryStore` say what already was.

/** How often the server looks for a new day, and for an update that ended since it started. */
const REPORT_INTERVAL = "10 minutes";

const Count = Schema.Struct({ n: Schema.Number });

const decodeVersion = Schema.decodeUnknownOption(ReleaseVersion);

/**
 * The release the server runs now, against the one it ran when it last
 * started: `update.applied` when they differ, however the update was made (a
 * client, a shell, the desktop app). None the first time, or when either is
 * not a release (a checkout's).
 */
export const versionChange = (
  lastVersion: string | null,
  current: string,
): Option.Option<TelemetryEvent> => {
  if (lastVersion === null || lastVersion === current) return Option.none();
  const from = decodeVersion(lastVersion);
  const to = decodeVersion(current);
  if (Option.isNone(from) || Option.isNone(to)) return Option.none();
  return Option.some({
    event: "update.applied",
    properties: { from: from.value, to: to.value, outcome: "updated", failure: null },
  });
};

/**
 * An update a client started that did not end on the new release, and was
 * not told yet. One that ended on it is told by `versionChange`, since the
 * new release starts.
 */
export const failedRun = (run: UpdateRun, told: string | null): Option.Option<TelemetryEvent> => {
  const { outcome } = run;
  if (outcome === undefined || outcome._tag === "done" || run.id === told) return Option.none();
  return Option.some({
    event: "update.applied",
    properties: { from: run.from, to: run.to, outcome: outcome._tag, failure: outcome.reason },
  });
};

/**
 * Tells `server.started` once the server runs, then, for as long as it does,
 * `install.active` once each UTC day usage data is sent, and how a client's
 * update ended.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const store = yield* TelemetryStore;
    const sql = yield* SqlClient.SqlClient;
    const { home } = yield* ServerConfig;
    const config = yield* TelemetryConfig;
    const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const count = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
      SqlSchema.findOne({ Request: Schema.Void, Result: Count, execute: () => query })(
        undefined,
      ).pipe(Effect.map((row) => countBucket(row.n)));

    const active = Effect.gen(function* () {
      const day = DateTime.formatIsoDateUtc(yield* DateTime.now);
      const { activeDay } = yield* store.marks;
      // Told only while it is sent, so a day the switch is turned on still counts.
      if (activeDay === day || !(yield* telemetry.sending)) return;
      yield* telemetry.record({
        event: "install.active",
        properties: {
          bots: yield* count(sql`SELECT COUNT(*) AS n FROM bots`),
          rooms: yield* count(sql`SELECT COUNT(*) AS n FROM rooms WHERE status = 'active'`),
          routines: yield* count(sql`SELECT COUNT(*) AS n FROM routines WHERE enabled = 1`),
          connectors: yield* count(sql`SELECT COUNT(*) AS n FROM connectors`),
        },
      });
      yield* store.mark({ activeDay: day });
    });

    const update = Effect.fn("TelemetryReports.update")(function* (marks: TelemetryMarks) {
      const recorded = yield* readRun(home).pipe(Effect.provideContext(files));
      if (recorded._tag !== "recorded" || recorded.run.outcome === undefined) return;
      if (recorded.run.id === marks.toldUpdateRun) return;
      yield* Effect.forEach(Option.toArray(failedRun(recorded.run, marks.toldUpdateRun)), (event) =>
        telemetry.record(event),
      );
      yield* store.mark({ toldUpdateRun: recorded.run.id });
    });

    // What the server says of itself can take a while to read, so none of it is on the start's way.
    const begin = Effect.gen(function* () {
      const { j3Version } = yield* config.server;
      const marks = yield* store.marks;
      yield* telemetry.record({ event: "server.started", properties: {} });
      yield* Effect.forEach(Option.toArray(versionChange(marks.lastVersion, j3Version)), (event) =>
        telemetry.record(event),
      );
      yield* store.mark({ lastVersion: j3Version });
    });

    // A failed tick is logged and the next one tries again: usage data never stops the server.
    const tick = Effect.gen(function* () {
      yield* update(yield* store.marks);
      yield* active;
    }).pipe(Effect.catchCause((cause) => Effect.logDebug("A usage report failed", { cause })));
    yield* begin.pipe(
      Effect.catchCause((cause) => Effect.logDebug("A usage report failed", { cause })),
      Effect.andThen(tick.pipe(Effect.andThen(Effect.sleep(REPORT_INTERVAL)), Effect.forever)),
      Effect.forkScoped,
    );
  }),
);
