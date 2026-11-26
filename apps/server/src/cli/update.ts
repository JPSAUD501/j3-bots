// SPDX-License-Identifier: AGPL-3.0-or-later
import { signatureCheck } from "@j3-bots/release/node";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stdio from "effect/Stdio";
import { Command, Flag, Prompt } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { heldOff, type Snapshot, takenAt } from "../install/snapshot.ts";
import { trustedReleaseKeys } from "../releases/keys.ts";
import type { UpdateFailure } from "@j3-bots/contracts";
import type { StepFailed } from "../transition/switch.ts";
import {
  abandonRollback,
  rollBack,
  update,
  type UpdateResult,
  type UpdateStage,
} from "../install/update.ts";
import * as ServerConfig from "../config.ts";
import { updateUnit } from "../update/launch.ts";
import { advanceRun, endRun, type Ending, isUnderway, readRun } from "../update/run.ts";
import { refuse, userFacing } from "./errors.ts";

const versionFlag = Flag.String("version").pipe(
  Flag.withDescription(
    "Install this release, a pre-release included, such as 0.1.0 or 0.1.0-rc.1 (default: the latest release, never a pre-release).",
  ),
  Flag.optional,
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Answer yes for you, as a script needs: stop the work bots have running for an update, or roll back without asking.",
  ),
);

const rollbackFlag = Flag.Boolean("rollback").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Put back the release that ran before the last update, and the databases as they were when it updated. Asks first.",
  ),
);

const abandonFlag = Flag.Boolean("abandon").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "With --rollback: give up a rollback that stopped before it put any of the snapshot back, as one does every time when a file of the snapshot is lost, and start the release the snapshot was taken for again, on the data as it is. Asks first.",
  ),
);

const runFlag = Flag.String("run").pipe(
  Flag.withDescription(
    "Carry out the update a client asked for, which the server recorded as this run, and record each stage and how it ended. The server starts this itself; it needs --version, and stops bots' work only if the client said so.",
  ),
  Flag.optional,
);

const LOG = "Read why with `journalctl --user -u j3-bots -n 100`.";

/**
 * Runs `effect` with this process kept alive when its terminal hangs up, as
 * when an SSH connection drops: an update cut off midway leaves the service
 * stopped or the command on the release before. The releases it runs are in
 * sessions of their own, which a hangup does not reach, with their output
 * relayed through this process; output to a terminal that is gone is dropped,
 * as Node's console drops write errors.
 */
const carryingOnAfterHangup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const ignore = () => {};
      process.on("SIGHUP", ignore);
      return ignore;
    }),
    () => effect,
    (ignore) => Effect.sync(() => process.off("SIGHUP", ignore)),
  );

/**
 * What a rollback to `snapshot` that stopped at `step` leaves: from its mark
 * until the old release runs and is recorded, the rollback is unfinished
 * until `--rollback` carries it on. Pointing the command comes after. A
 * rollback that stopped before it put anything back may be given up instead,
 * unless its mark could not be read with a swap begun: that one only goes on.
 */
const unfinishedRollback = (step: StepFailed, snapshot: Snapshot) => {
  const release = snapshot.manifest.from.version;
  switch (step.step) {
    case "mark":
    case "adopt":
      return [];
    case "record":
    case "unmark":
      return [
        `The databases are back, but the rollback has not finished, so ${heldOff(release, true)}: \`j3-bots update --rollback\` finishes it, without copying the databases again.`,
      ];
    case "start-old":
    case "await-old":
      return [
        `The databases are back, but the rollback has not finished, so ${heldOff(release, true)}: \`j3-bots update --rollback\` finishes it.`,
      ];
    default:
      if (Option.exists(snapshot.restoring, ({ stage }) => stage === "unread")) {
        return [
          `The rollback has not finished, so ${heldOff(release, false)}: \`j3-bots update --rollback\` finishes it.`,
        ];
      }
      return [
        `The rollback has not finished, so ${heldOff(release, false)}: \`j3-bots update --rollback\` finishes it. If it stops again before it puts any of the snapshot back, as it does every time when a file of the snapshot is lost or damaged, \`j3-bots update --rollback --abandon\` gives it up and starts J3 Bots ${snapshot.manifest.to.version} again on the data as it is.`,
      ];
  }
};

/** Asks `question` on a terminal, or answers no without one. */
const ask = Effect.fn("update.ask")(function* (question: string) {
  if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) return false;
  return yield* Prompt.run(Prompt.Confirm({ message: question, initial: false })).pipe(
    Effect.orElseSucceed(() => false),
  );
});

const bots = (count: Option.Option<number>) =>
  Option.match(count, {
    onNone: () => "Bots may have work running (the server could not say)",
    onSome: (n) => (n === 1 ? "1 bot has work running" : `${n} bots have work running`),
  });

/**
 * What to say when the home's record could not say that `to` runs: the update
 * stays pending in it, and the next update to `to` carries it on, with the
 * snapshot it took.
 */
const unrecorded = (recording: Option.Option<string>, to: string) =>
  Option.match(recording, {
    onNone: () => [],
    onSome: (reason) => [
      `Writing the data directory's record of the release that runs, state/runtime.json, failed: ${reason} Until it is written, the update counts as unfinished: \`j3-bots update --version ${to}\` carries it on and writes it.`,
    ],
  });

/** Why a step failed, as a sentence for the operator: a reason that already ends one keeps its stop. */
const failure = (step: StepFailed) =>
  /[.!?]$/.test(step.reason) ? step.reason : `${step.reason}.`;

/** How often a download's progress is written to its run, at most. */
const PROGRESS_EVERY = Duration.seconds(1);

/**
 * What records each stage of run `id` in `home`: every stage as it comes,
 * and a download's bytes at most once a `PROGRESS_EVERY`, and when it ends.
 */
const recordStages = Effect.fnUntraced(function* (home: string, id: string) {
  const written = yield* Ref.make(0);
  return (stage: UpdateStage): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (
        stage._tag === "downloading" &&
        stage.receivedBytes > 0 &&
        stage.receivedBytes !== stage.totalBytes &&
        now - (yield* Ref.get(written)) < Duration.toMillis(PROGRESS_EVERY)
      ) {
        return;
      }
      yield* Ref.set(written, now);
      yield* advanceRun(home, id, stage).pipe(Effect.ignore);
    });
});

/** What a step that failed means for a client: the new release never became ready, or another step failed. */
const failureOf = (step: StepFailed): UpdateFailure =>
  step.step === "start-new" || step.step === "await-new" ? "health-check" : "other";

/** Why an update stopped before it changed anything, for a client. */
const refusalOf = (error: Effect.Error<ReturnType<typeof update>>): UpdateFailure => {
  switch (error._tag) {
    case "ReleaseNotFetched":
      switch (error.reason) {
        case "checksum":
        case "unsigned":
          return "verification";
        case "latest-unreadable":
        case "latest-not-stable":
        case "checksums-unreadable":
        case "no-archive":
        case "download":
          return "download";
        default:
          return "other";
      }
    case "UpdateRefused":
      return error.reason === "engine-fetch"
        ? "engine"
        : error.reason === "disk"
          ? "disk"
          : "other";
    default:
      return "other";
  }
};

/** What an update came to: what the operator reads, and how a client's run of it ended. */
interface Report {
  readonly ending: Ending;
  readonly text: string;
}

/** The report of an update that ran to `result`. */
const reportOf = (result: UpdateResult): Report => {
  switch (result._tag) {
    case "current":
      return {
        ending: { _tag: "done" },
        text: `J3 Bots ${result.version} is installed already.`,
      };
    case "repointed":
      return {
        ending: { _tag: "done" },
        text: `The service runs J3 Bots ${result.version} already; the j3-bots command now runs it too.`,
      };
    case "declined":
      return {
        ending: {
          _tag: "rolled-back",
          reason: "other",
          detail:
            "Bots had work running when the update was ready to stop the service, and it was not to stop it, so nothing was changed. Update again once the work is done, or let the update stop it.",
        },
        text: "Bots have work running, which the update would stop, so nothing was changed. Run this again once it is done, or with --yes to stop it.",
      };
    case "switched":
      break;
  }
  const { outcome, to } = result;
  const from = result.from.version;
  // An update cut off before it was recorded, to another release, is rolled back first.
  const cutOff = Option.match(result.interrupted, {
    onNone: () => [],
    onSome: (release) => [
      `An update from J3 Bots ${from} to ${release.version} was cut off before ${release.version} was recorded, so it was rolled back first: the databases are as they were before it.`,
    ],
  });
  switch (outcome._tag) {
    case "cut-off-rolled-back":
      return {
        ending: { _tag: "done" },
        text: [
          ...cutOff,
          result.service
            ? `J3 Bots ${from} runs again, and its engine is ready.`
            : `J3 Bots ${from} is installed again. Start the server with \`j3-bots serve\`.`,
        ].join("\n"),
      };
    case "cut-off-rollback-failed": {
      const reason = `Rolling back an earlier update that was cut off, to J3 Bots ${from}, failed: ${failure(outcome.rollback)}`;
      const unfinished = unfinishedRollback(outcome.rollback, outcome.snapshot);
      return {
        ending: { _tag: "failed", reason: "other", detail: reason },
        text: [
          ...Option.match(result.interrupted, {
            onNone: () => [],
            onSome: (release) => [
              `An update from J3 Bots ${from} to ${release.version} was cut off before ${release.version} was recorded, so it is rolled back before J3 Bots ${to} starts.`,
            ],
          }),
          `Rolling it back to J3 Bots ${from} failed: ${failure(outcome.rollback)}`,
          `The databases as they were before it are in ${outcome.snapshot.folder}.`,
          ...(unfinished.length > 0
            ? unfinished
            : [`\`j3-bots update --version ${to}\` tries again.`]),
          LOG,
        ].join("\n"),
      };
    }
    case "updated": {
      const lines = [
        ...cutOff,
        result.service
          ? `J3 Bots ${to} runs, and its engine is ready. ${from} and the databases as they were are kept: \`j3-bots update --rollback\` puts them back.`
          : `J3 Bots ${to} is installed. ${from} and the databases as they were are kept: \`j3-bots update --rollback\` puts them back. Start the server with \`j3-bots serve\`.`,
        `Snapshot: ${outcome.snapshot.folder}. The two newest snapshots are kept; an older one is removed with what its rollbacks replaced, in its replaced-* folders.`,
      ];
      if (Option.isSome(outcome.adopt)) {
        lines.push(
          `${failure(outcome.adopt.value)} The service runs ${to} all the same; \`j3-bots update --version ${to}\` points the command at it.`,
        );
      }
      if (Option.isSome(result.pruning)) {
        lines.push(`Removing older releases and snapshots failed: ${result.pruning.value}`);
      }
      lines.push(...unrecorded(result.recording, to));
      return { ending: { _tag: "done" }, text: lines.join("\n") };
    }
    case "rolled-back":
      return {
        ending: {
          _tag: "rolled-back",
          reason: failureOf(outcome.failed),
          detail: failure(outcome.failed),
        },
        text: [
          ...cutOff,
          `The update to J3 Bots ${to} did not finish: ${failure(outcome.failed)}`,
          ...Option.match(outcome.restored, {
            onSome: (snapshot) => [
              `J3 Bots ${from} runs again, on the databases as they were before the update.`,
              `What J3 Bots ${to} recorded while the update waited for it, such as a message sent then, is not in them: it is kept in ${snapshot.folder}, in its replaced-* folder.`,
              ...(result.service ? [LOG] : []),
            ],
            onNone: () => [
              result.service
                ? `J3 Bots ${from} runs again; the databases were not changed.`
                : `J3 Bots ${from} stays installed; the databases were not changed.`,
            ],
          }),
        ].join("\n"),
      };
    case "rollback-failed": {
      const unfinished = Option.match(outcome.snapshot, {
        onNone: () => [],
        onSome: (snapshot) => unfinishedRollback(outcome.rollback, snapshot),
      });
      return {
        ending: {
          _tag: "failed",
          reason: failureOf(outcome.failed),
          detail: `The update to J3 Bots ${to} did not finish: ${failure(outcome.failed)} Bringing J3 Bots ${from} back failed too: ${failure(outcome.rollback)}`,
        },
        text: [
          ...cutOff,
          `The update to J3 Bots ${to} did not finish: ${failure(outcome.failed)}`,
          `Bringing J3 Bots ${from} back failed too: ${failure(outcome.rollback)}`,
          ...Option.match(outcome.snapshot, {
            onNone: () => ["The databases were not changed."],
            onSome: (snapshot) => [
              `The databases as they were before the update are in ${snapshot.folder}.`,
              ...unfinished,
            ],
          }),
          LOG,
        ].join("\n"),
      };
    }
  }
};

/**
 * The run `id` a client asked for, recorded in the home as underway to
 * `version`: what `--run` carries out, and nothing else.
 */
const clientRun = Effect.fn("update.clientRun")(function* (
  id: string,
  version: Option.Option<string>,
) {
  const home = yield* ServerConfig.resolveHome;
  const recorded = yield* readRun(home);
  if (recorded._tag !== "recorded" || recorded.run.id !== id || !isUnderway(recorded.run)) {
    return yield* refuse(`${home} records no update underway as ${id}, so nothing was changed.`);
  }
  const { run } = recorded;
  if (
    !Option.contains(
      Option.map(version, (wanted) => wanted.replace(/^v/, "")),
      run.to,
    )
  ) {
    return yield* refuse(
      `The update ${id} installs J3 Bots ${run.to}; --version must name it. Nothing was changed.`,
    );
  }
  return { home, id, stopWork: run.stopWork, from: run.from };
});

/**
 * Whether the update may stop the work bots have running, `count` of them when
 * the server could say, asked once
 * it is ready to stop the service. A client's run answers with what the
 * client sent, whatever else was given: work begun after it asked is stopped
 * only if it said so. Otherwise `--yes` answers, or the operator does.
 */
export const stopsWork =
  <E, R>(
    tracked: Option.Option<{ readonly stopWork: boolean }>,
    yes: boolean,
    ask: (count: Option.Option<number>) => Effect.Effect<boolean, E, R>,
  ) =>
  (count: Option.Option<number>): Effect.Effect<boolean, E, R> =>
    Option.match(tracked, {
      onSome: ({ stopWork }) => Effect.succeed(stopWork),
      onNone: () => (yes ? Effect.succeed(true) : ask(count)),
    });

/**
 * Runs an update and reports it. With `run`, the update is the one a client
 * asked for (`../update/UpdateRuns.ts`): only the run the home records as
 * underway, to exactly `version`, is carried out, and its record is told each
 * stage and how it ended.
 */
const runUpdate = Effect.fn("update.run")(function* (
  version: Option.Option<string>,
  yes: boolean,
  run: Option.Option<string>,
) {
  const tracked = Option.isSome(run)
    ? Option.some(yield* clientRun(run.value, version))
    : Option.none();
  // A client reads how it ended away from this output, which goes to the unit's journal.
  const end = (ending: Ending) =>
    Option.match(tracked, {
      onNone: () => Effect.void,
      onSome: ({ home, id }) =>
        endRun(
          home,
          id,
          ending._tag === "done"
            ? ending
            : {
                ...ending,
                detail: `${ending.detail} What the update printed is in \`journalctl --user -u ${updateUnit(id)}\`.`,
              },
        ).pipe(Effect.ignore),
    });
  const progress = Option.isSome(tracked)
    ? yield* recordStages(tracked.value.home, tracked.value.id)
    : () => Effect.void;
  const check = signatureCheck(yield* trustedReleaseKeys);
  const result = yield* update({
    version,
    confirm: stopsWork(tracked, yes, (count) =>
      ask(`${bots(count)}, and the update stops it. Update now?`),
    ),
    say: (line) => Console.log(line),
    progress,
    check,
    from: Option.map(tracked, ({ from }) => from),
  }).pipe(
    // Nothing was changed: the release before runs, on the data as it was.
    Effect.tapError((error) =>
      end({ _tag: "rolled-back", reason: refusalOf(error), detail: error.message }),
    ),
    userFacing,
  );
  const report = reportOf(result);
  yield* end(report.ending);
  if (report.ending._tag === "done") return yield* Console.log(report.text);
  return yield* refuse(report.text);
});

const runRollback = Effect.fn("update.runRollback")(function* (yes: boolean) {
  const result = yield* userFacing(
    rollBack({
      confirm: (snapshot) => {
        const { from, to } = snapshot.manifest;
        const resumed = Option.isSome(snapshot.restoring)
          ? `A rollback to J3 Bots ${from.version} did not finish; this finishes it. `
          : "";
        const warning = `${resumed}This puts back J3 Bots ${from.version} and the databases as they were at ${takenAt(snapshot)}, when ${to.version} was installed. What the databases recorded since then is lost: conversations, rooms, routines, settings, paired devices and the engine's threads. Bots' files on disk, their memory included, stay as they are.`;
        if (yes) return Console.log(warning).pipe(Effect.as(true));
        return Console.log(warning).pipe(Effect.andThen(ask("Roll back now?")));
      },
    }),
  );
  if (result._tag === "declined") {
    return yield* refuse(
      "Nothing was changed. Without a terminal to ask on, --yes answers for you.",
    );
  }
  const { from } = result.snapshot.manifest;
  if (Option.isSome(result.failed) && result.failed.value.step === "adopt") {
    return yield* refuse(
      `The rollback to J3 Bots ${from.version} finished, but ${failure(result.failed.value)} \`j3-bots update --version ${from.version}\` points the command at it.`,
    );
  }
  if (Option.isSome(result.failed)) {
    return yield* refuse(
      [
        `The rollback to J3 Bots ${from.version} did not finish: ${failure(result.failed.value)}`,
        `The snapshot is in ${result.snapshot.folder}; what it replaced is beside it, in its replaced-* folder.`,
        ...unfinishedRollback(result.failed.value, result.snapshot),
        LOG,
      ].join("\n"),
    );
  }
  yield* Console.log(
    [
      result.service
        ? `J3 Bots ${from.version} runs again, on the databases as they were at ${takenAt(result.snapshot)}, and its engine is ready.`
        : `J3 Bots ${from.version} is installed again, with the databases as they were at ${takenAt(result.snapshot)}.`,
      `What the rollback replaced is kept in ${result.snapshot.folder}, in its replaced-* folder, until an update removes that snapshot.`,
    ].join("\n"),
  );
});

const runAbandon = Effect.fn("update.runAbandon")(function* (yes: boolean) {
  const result = yield* userFacing(
    abandonRollback({
      confirm: (snapshot) => {
        const { from, to } = snapshot.manifest;
        const warning = `This gives up the rollback to J3 Bots ${from.version}, from ${snapshot.folder}, which has put none of it back: the data directory is as J3 Bots ${to.version} left it, and J3 Bots ${to.version} starts on it again. Nothing in it is changed, and the snapshot stays in backups/.`;
        if (yes) return Console.log(warning).pipe(Effect.as(true));
        return Console.log(warning).pipe(Effect.andThen(ask("Give up the rollback?")));
      },
    }),
  );
  if (result._tag === "declined") {
    return yield* refuse(
      "Nothing was changed. Without a terminal to ask on, --yes answers for you.",
    );
  }
  const { to } = result.snapshot.manifest;
  if (Option.isSome(result.failed) && result.failed.value.step === "adopt") {
    return yield* refuse(
      `The rollback was given up and J3 Bots ${to.version} runs, but ${failure(result.failed.value)} \`j3-bots update --version ${to.version}\` points the command at it.`,
    );
  }
  if (Option.isSome(result.failed)) {
    const { step } = result.failed.value;
    return yield* refuse(
      step === "record" || step === "unmark"
        ? `Giving up the rollback did not finish: ${failure(result.failed.value)} The rollback is still unfinished: \`j3-bots update --rollback --abandon\` tries again.`
        : [
            `The rollback is given up, and the data directory is J3 Bots ${to.version}'s again, but starting it failed: ${failure(result.failed.value)}`,
            `Once it runs, \`j3-bots update --version ${to.version}\` points the command at it.`,
            LOG,
          ].join("\n"),
    );
  }
  yield* Console.log(
    result.service
      ? `The rollback is given up. J3 Bots ${to.version} runs again, on the data directory as it was, and its engine is ready.`
      : `The rollback is given up. J3 Bots ${to.version} is installed again, on the data directory as it was. Start the server with \`j3-bots serve\`.`,
  );
});

export const updateCommand = Command.make("update", {
  version: versionFlag,
  yes: yesFlag,
  rollback: rollbackFlag,
  abandon: abandonFlag,
  run: runFlag,
}).pipe(
  Command.withDescription(
    "Update J3 Bots, installed with install.sh, to the latest release or to --version. It copies the databases first, and if the new release does not start, puts them and the release before back by itself. --rollback puts them back on request.",
  ),
  Command.withHandler(({ version, yes, rollback, abandon, run }) =>
    Effect.gen(function* () {
      if (abandon && !rollback) {
        return yield* refuse("--abandon gives up a rollback; it goes with --rollback.");
      }
      if (!rollback) return yield* runUpdate(version, yes, run);
      if (Option.isSome(run)) {
        return yield* refuse("--rollback is asked for on the server's machine; it takes no --run.");
      }
      if (Option.isSome(version)) {
        return yield* refuse(
          "--rollback puts back the release before the last update; it takes no --version.",
        );
      }
      return yield* abandon ? runAbandon(yes) : runRollback(yes);
    }).pipe(carryingOnAfterHangup, Effect.provide(FetchHttpClient.layer)),
  ),
);
