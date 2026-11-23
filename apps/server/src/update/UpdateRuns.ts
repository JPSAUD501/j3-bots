// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DeviceId,
  type ReleaseVersion,
  type UpdateInability,
  UpdateRefused,
  type UpdateStatus,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { Ids } from "../Ids.ts";
import { unfinishedRollback } from "../install/snapshot.ts";
import { TransitionLock } from "../transition/transition.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import { updateUnit } from "./launch.ts";
import { UpdateLauncher } from "./UpdateLauncher.ts";
import { endRun, isUnderway, readRun, type UpdateRun, writeRun } from "./run.ts";

// The updates clients ask for: whether this server can update itself, the one
// that runs, and how the last one ended (docs/architecture/server.md,
// "Updating from a client"). The update itself is the installed release's
// `j3-bots update`, run in a transient unit (`launch.ts`); this starts it,
// once every gate passed, and reads what it records (`run.ts`).
//
// Only a paired device asks (the routes check its token), and only for the
// release the feed verified, which must be newer than this one and on the
// server's channel: no request names a file or an address. One update at a
// time: a run that has not ended, or a `j3-bots update` from a shell, which
// holds the home's update lock, makes a second one `busy`.

/** What of `UpdateStatus` the runs answer for. */
export type RunsView = Pick<UpdateStatus, "canUpdate" | "state" | "lastResult" | "run">;

/** What a client asks to start. */
export interface StartRequest {
  readonly version: ReleaseVersion;
  readonly stopWork: boolean;
  readonly device: DeviceId;
  /** The feed's verified release on the server's channel, newer than this one: the only one `start` installs. */
  readonly available: Option.Option<ReleaseVersion>;
}

export class UpdateRuns extends Context.Service<
  UpdateRuns,
  {
    readonly view: Effect.Effect<RunsView>;
    /** Starts the update `request` asks for, once every gate passes, and returns once it runs. */
    readonly start: (request: StartRequest) => Effect.Effect<void, UpdateRefused>;
  }
>()("@j3-bots/server/update/UpdateRuns") {}

/** The command that finishes an unfinished rollback, on the server's machine. */
const FINISH_ROLLBACK = "j3-bots update --rollback";

/** The client's view of a run that ended, or none while it has not. */
const resultOf = (run: UpdateRun): UpdateStatus["lastResult"] => {
  const { outcome } = run;
  if (outcome === undefined) return null;
  return {
    outcome: outcome._tag,
    from: run.from,
    to: run.to,
    at: outcome.at,
    by: run.by,
    reason: outcome._tag === "done" ? null : outcome.reason,
    detail: outcome._tag === "done" ? null : outcome.detail,
  };
};

/** The runs of the server of `ServerConfig.home`. */
export const layer = Layer.effect(
  UpdateRuns,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const launcher = yield* UpdateLauncher;
    const ids = yield* Ids;
    const runningWork = yield* RunningWork;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    // A start and the check that ends a run cut off never interleave.
    const permit = yield* Semaphore.make(1);

    const rollbackUnfinished = unfinishedRollback(home).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    );

    /** Why it cannot update now, or none. */
    const inability = Effect.gen(function* () {
      const host = yield* launcher.host;
      if (host._tag === "cannot") {
        return Option.some({ reason: host.reason, command: host.command });
      }
      if (yield* rollbackUnfinished) {
        const reason: UpdateInability = "rollback-unfinished";
        return Option.some({ reason, command: FINISH_ROLLBACK });
      }
      return Option.none<{ readonly reason: UpdateInability; readonly command: string | null }>();
    });

    /**
     * The recorded run, while this holds `permit`. One that has not ended
     * while its unit has, as when the machine restarted under it or it could
     * not even start, is ended here as `interrupted`, with where its output
     * went.
     */
    const recordedRun = Effect.gen(function* () {
      const recorded = yield* readRun(home);
      if (recorded._tag !== "recorded") return Option.none<UpdateRun>();
      const { run } = recorded;
      if (!isUnderway(run) || !(yield* launcher.ended(run.id))) return Option.some(run);
      yield* Effect.logWarning("An update ended without recording how", {
        run: run.id,
        to: run.to,
      });
      yield* endRun(home, run.id, {
        _tag: "failed",
        reason: "interrupted",
        detail: `The update to J3 Bots ${run.to} stopped before it recorded how it ended, as when the machine or its service manager restarts. What it printed is in \`journalctl --user -u ${updateUnit(run.id)}\`; \`j3-bots doctor\` says which release runs.`,
      });
      const again = yield* readRun(home);
      return again._tag === "recorded" ? Option.some(again.run) : Option.none<UpdateRun>();
    }).pipe(Effect.orElseSucceed(Option.none<UpdateRun>));

    const view = Effect.gen(function* () {
      const run = yield* permit.withPermits(1)(recordedRun);
      const cannot = yield* inability;
      const underway = Option.filter(run, isUnderway);
      return {
        canUpdate: Option.match(cannot, {
          onNone: () => ({ _tag: "able" as const }),
          onSome: ({ reason, command }) => ({ _tag: "unable" as const, reason, command }),
        }),
        state: Option.match(underway, {
          onNone: () => ({ _tag: "idle" as const }),
          onSome: ({ stage }) => stage,
        }),
        lastResult: Option.match(run, { onNone: () => null, onSome: resultOf }),
        run: Option.match(underway, {
          onNone: () => null,
          onSome: ({ from, to, by, startedAt }) => ({ from, to, by, startedAt }),
        }),
      } satisfies RunsView;
    }).pipe(Effect.provideContext(context));

    const refused = (reason: UpdateRefused["reason"], runningBots: number | null = null) =>
      new UpdateRefused({ reason, runningBots });

    const start = Effect.fn("UpdateRuns.start")(function* (request: StartRequest) {
      const host = yield* launcher.host;
      if (host._tag !== "service" || (yield* rollbackUnfinished)) return yield* refused("unable");
      if (!Option.contains(request.available, request.version)) {
        return yield* refused("not-available");
      }
      yield* permit.withPermits(1)(
        Effect.gen(function* () {
          if (Option.exists(yield* recordedRun, isUnderway)) return yield* refused("busy");
          // An update from a shell holds the home's update lock while it runs.
          const free = yield* Effect.scoped(TransitionLock.hold(home, () => "busy" as const)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!free) return yield* refused("busy");
          if (!request.stopWork) {
            const bots = (yield* runningWork.bots).length;
            if (bots > 0) return yield* refused("work-running", bots);
          }
          const run: UpdateRun = {
            schema: 1,
            id: yield* ids.make("update"),
            from: packageJson.version,
            to: request.version,
            by: request.device,
            startedAt: yield* DateTime.now,
            stage: { _tag: "downloading", receivedBytes: 0, totalBytes: null },
          };
          yield* writeRun(home, run).pipe(Effect.orDie);
          yield* Effect.logInfo("Updating at a client's request", {
            run: run.id,
            from: run.from,
            to: run.to,
            device: run.by,
          });
          yield* launcher
            .launch({
              id: run.id,
              version: run.to,
              command: host.command,
              home: host.home,
              searchPath: host.searchPath,
              release: host.release,
            })
            .pipe(
              Effect.catchTag("LaunchFailed", (error) =>
                Effect.logError("The update did not start", {
                  run: run.id,
                  reason: error.message,
                }).pipe(
                  Effect.andThen(
                    endRun(home, run.id, {
                      _tag: "rolled-back",
                      reason: "other",
                      detail: `${error.message} Nothing was changed.`,
                    }),
                  ),
                  Effect.orDie,
                ),
              ),
            );
        }),
      );
    }, Effect.provideContext(context));

    return UpdateRuns.of({ view, start });
  }),
);
