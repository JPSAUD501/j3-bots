// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stdio from "effect/Stdio";
import { Command, Flag, Prompt } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { takenAt } from "../install/snapshot.ts";
import type { StepFailed } from "../transition/switch.ts";
import { rollBack, update } from "../install/update.ts";
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
 * What a rollback that stopped at `step` leaves: from its mark until the old
 * release runs and is recorded, the rollback is unfinished until
 * `--rollback` carries it on. Pointing the command comes after.
 */
const unfinishedRollback = (step: StepFailed) => {
  switch (step.step) {
    case "mark":
    case "adopt":
      return [];
    case "record":
    case "unmark":
      return [
        "The service runs the release before again, but the rollback has not finished, so no other release may run on the data directory: `j3-bots update --rollback` finishes it, without copying the databases again.",
      ];
    default:
      return [
        "The rollback has not finished, so the service stays disabled and no other release may run on the data directory: `j3-bots update --rollback` finishes it.",
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

const runUpdate = Effect.fn("update.run")(function* (version: Option.Option<string>, yes: boolean) {
  const result = yield* userFacing(
    update({
      version,
      confirm: (count) =>
        yes ? Effect.succeed(true) : ask(`${bots(count)}, and the update stops it. Update now?`),
      say: (line) => Console.log(line),
    }),
  );
  switch (result._tag) {
    case "current":
      return yield* Console.log(`J3 Bots ${result.version} is installed already.`);
    case "repointed":
      return yield* Console.log(
        `The service runs J3 Bots ${result.version} already; the j3-bots command now runs it too.`,
      );
    case "declined":
      return yield* refuse(
        "Bots have work running, which the update would stop, so nothing was changed. Run this again once it is done, or with --yes to stop it.",
      );
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
      return yield* Console.log(
        [
          ...cutOff,
          result.service
            ? `J3 Bots ${from} runs again, and its engine is ready.`
            : `J3 Bots ${from} is installed again. Start the server with \`j3-bots serve\`.`,
        ].join("\n"),
      );
    case "cut-off-rollback-failed":
      return yield* refuse(
        [
          ...Option.match(result.interrupted, {
            onNone: () => [],
            onSome: (release) => [
              `An update from J3 Bots ${from} to ${release.version} was cut off before ${release.version} was recorded, so it is rolled back before J3 Bots ${to} starts.`,
            ],
          }),
          `Rolling it back to J3 Bots ${from} failed: ${failure(outcome.rollback)}`,
          `The databases as they were before it are in ${outcome.snapshot.folder}.`,
          ...(outcome.rollback.step === "mark" || outcome.rollback.step === "adopt"
            ? [`\`j3-bots update --version ${to}\` tries again.`]
            : unfinishedRollback(outcome.rollback)),
          LOG,
        ].join("\n"),
      );
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
      return yield* Console.log(lines.join("\n"));
    }
    case "rolled-back":
      return yield* refuse(
        [
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
      );
    case "rollback-failed":
      return yield* refuse(
        [
          ...cutOff,
          `The update to J3 Bots ${to} did not finish: ${failure(outcome.failed)}`,
          `Bringing J3 Bots ${from} back failed too: ${failure(outcome.rollback)}`,
          ...Option.match(outcome.snapshot, {
            onNone: () => ["The databases were not changed."],
            onSome: (snapshot) => [
              `The databases as they were before the update are in ${snapshot.folder}.`,
              ...unfinishedRollback(outcome.rollback),
            ],
          }),
          LOG,
        ].join("\n"),
      );
  }
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
        ...unfinishedRollback(result.failed.value),
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

export const updateCommand = Command.make("update", {
  version: versionFlag,
  yes: yesFlag,
  rollback: rollbackFlag,
}).pipe(
  Command.withDescription(
    "Update J3 Bots, installed with install.sh, to the latest release or to --version. It copies the databases first, and if the new release does not start, puts them and the release before back by itself. --rollback puts them back on request.",
  ),
  Command.withHandler(({ version, yes, rollback }) =>
    Effect.gen(function* () {
      if (!rollback) return yield* runUpdate(version, yes);
      if (Option.isSome(version)) {
        return yield* refuse(
          "--rollback puts back the release before the last update; it takes no --version.",
        );
      }
      return yield* runRollback(yes);
    }).pipe(carryingOnAfterHangup, Effect.provide(FetchHttpClient.layer)),
  ),
);
