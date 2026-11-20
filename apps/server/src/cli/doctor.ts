// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";
import { type Check, type CheckStatus, diagnose } from "../doctor/Doctor.ts";

const MARKS: Record<CheckStatus, string> = {
  ok: "✓",
  warning: "!",
  problem: "✗",
  skipped: "-",
};

/** The report, one check per line and its fix under it. */
const formatReport = (checks: ReadonlyArray<Check>) => {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines = checks.flatMap((check) => [
    `${MARKS[check.status]} ${check.name.padEnd(width)}  ${check.summary}`,
    ...Option.match(check.fix, {
      onNone: () => [],
      onSome: (fix) => [`  ${" ".repeat(width)}  Fix: ${fix}`],
    }),
  ]);
  const problems = checks.filter((check) => check.status === "problem").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const verdict =
    problems === 0 && warnings === 0
      ? "Everything J3 Bots needs is in place."
      : problems === 0
        ? `No problems, ${plural(warnings, "warning")}.`
        : `${plural(problems, "problem")} to fix, ${plural(warnings, "warning")}.`;
  return [...lines, "", verdict].join("\n");
};

export const doctorCommand = Command.make("doctor").pipe(
  Command.withDescription(
    "Check what the server needs from this machine and explain how to fix what is missing. Changes nothing.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const checks = yield* diagnose;
      yield* Console.log(formatReport(checks));
      if (checks.some((check) => check.status === "problem")) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }),
  ),
);
