// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stdio from "effect/Stdio";
import { Command, Flag, Prompt } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { takenAt } from "../install/snapshot.ts";
import type { StepFailed } from "../install/switch.ts";
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

/** What a failed step leaves, in a sentence for the operator. */
const failure = (step: StepFailed) => `${step.reason}.`;

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
    case "declined":
      return yield* refuse(
        "Bots have work running, which the update would stop, so nothing was changed. Run this again once it is done, or with --yes to stop it.",
      );
    case "switched":
      break;
  }
  const { outcome, from, to } = result;
  switch (outcome._tag) {
    case "updated": {
      const lines = [
        result.service
          ? `J3 Bots ${to} runs, and its engine is ready. ${from} and the databases as they were are kept: \`j3-bots update --rollback\` puts them back.`
          : `J3 Bots ${to} is installed. ${from} and the databases as they were are kept: \`j3-bots update --rollback\` puts them back. Start the server with \`j3-bots serve\`.`,
        `Snapshot: ${outcome.snapshot.folder}`,
      ];
      if (Option.isSome(outcome.command)) {
        lines.push(
          `${failure(outcome.command.value)} The service runs ${to} all the same; run install.sh --version ${to} to write the command again.`,
        );
      }
      if (Option.isSome(result.pruning)) {
        lines.push(`Removing older releases and snapshots failed: ${result.pruning.value}`);
      }
      return yield* Console.log(lines.join("\n"));
    }
    case "rolled-back":
      return yield* refuse(
        [
          `The update to J3 Bots ${to} did not finish: ${failure(outcome.failed)}`,
          Option.isSome(outcome.restored)
            ? `J3 Bots ${from} runs again, on the databases as they were before the update. ${result.service ? LOG : ""}`.trim()
            : result.service
              ? `J3 Bots ${from} runs again; the databases were not changed.`
              : `J3 Bots ${from} stays installed; the databases were not changed.`,
        ].join("\n"),
      );
    case "rollback-failed":
      return yield* refuse(
        [
          `The update to J3 Bots ${to} did not finish: ${failure(outcome.failed)}`,
          `Bringing J3 Bots ${from} back failed too: ${failure(outcome.rollback)}`,
          Option.match(outcome.snapshot, {
            onNone: () => "The databases were not changed.",
            onSome: (snapshot) =>
              `The databases as they were before the update are in ${snapshot.folder}.`,
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
        const warning = `This puts back J3 Bots ${from.version} and the databases as they were at ${takenAt(snapshot)}, when ${to.version} was installed. What the databases recorded since then is lost: conversations, rooms, routines, settings, paired devices and the engine's threads. Bots' files on disk, their memory included, stay as they are.`;
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
  if (Option.isSome(result.failed)) {
    return yield* refuse(
      [
        `The rollback to J3 Bots ${from.version} did not finish: ${failure(result.failed.value)}`,
        `The snapshot is in ${result.snapshot.folder}; what it replaced is beside it, in its replaced-* folder.`,
        LOG,
      ].join("\n"),
    );
  }
  yield* Console.log(
    [
      result.service
        ? `J3 Bots ${from.version} runs again, on the databases as they were at ${takenAt(result.snapshot)}, and its engine is ready.`
        : `J3 Bots ${from.version} is installed again, with the databases as they were at ${takenAt(result.snapshot)}.`,
      `What the rollback replaced is kept in ${result.snapshot.folder}, in its replaced-* folder.`,
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
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
