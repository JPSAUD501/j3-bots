// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Windows PowerShell 5.1, which every supported Windows ships, for what the
// server must ask Windows and Node cannot: a folder's access control list.
// It is started by its full path under `SystemRoot`, never looked up on the
// search path the operator's shell set, without a profile, and the script
// goes as `-EncodedCommand`, so nothing in it is quoted for a command line.
// Values reach the script as environment variables, never in its text.

/** PowerShell could not be started, or the script failed. */
class PowerShellFailed extends Schema.TaggedError<PowerShellFailed>()("PowerShellFailed", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Windows PowerShell failed: ${this.detail}`;
  }
}

/** Windows PowerShell, by its full path, from `SystemRoot` in `environment`. */
const powerShellPath = (environment: Readonly<Record<string, string | undefined>>) =>
  `${environment["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/**
 * The arguments that run `script` without a profile or a prompt, stopping at
 * its first error, with its output in UTF-8: `-EncodedCommand` takes the
 * script as base64 of its UTF-16 text.
 */
const powerShellArgs = (script: string): ReadonlyArray<string> => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`,
    "utf16le",
  ).toString("base64"),
];

/**
 * `environment` without `PSModulePath`, which PowerShell 7 sets to its own
 * modules: Windows PowerShell 5.1 started from a PowerShell 7 session, as a
 * terminal or a CI runner opens one, inherits it, and then fails to load the
 * modules its first command is in. Without it, 5.1 finds its own.
 */
const withoutModulePath = (environment: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== "PSMODULEPATH",
    ),
  );

/** How long a script gets before it is stopped: PowerShell takes about a second to start. */
const RUN_WITHIN = "30 seconds";

/**
 * Runs `script` with `variables` added to this process's environment (but
 * `PSModulePath`), and
 * answers what it wrote to its output. A script that fails, or that runs
 * past its time, fails with what it wrote to its error output.
 */
export const runPowerShell = Effect.fn("PowerShell.run")(function* (
  script: string,
  variables: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* Effect.sync(() => process.env);
  const failed = (detail: string) => new PowerShellFailed({ detail });
  const { output, errors, exitCode } = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(powerShellPath(environment), powerShellArgs(script), {
          env: { ...withoutModulePath(environment), ...variables },
          extendEnv: false,
          stdin: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: "2 seconds",
        }),
      );
      const [output, errors, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText, Stream.mkString),
          handle.stderr.pipe(Stream.decodeText, Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { output, errors, exitCode: Number(exitCode) };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: RUN_WITHIN,
      orElse: () => Effect.fail(failed(`it ran for longer than ${RUN_WITHIN}`)),
    }),
    Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error.message))),
  );
  if (exitCode !== 0)
    return yield* failed(errors.trim() === "" ? `exit code ${exitCode}` : errors.trim());
  return output;
});
