// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { POWERSHELL, powerShellArgs, system32, withoutModulePath } from "@j3-bots/processes";

// Windows PowerShell 5.1, which every supported Windows ships, for what the
// server must ask Windows and Node cannot: a folder's access control list.
// It is started as the engine adapter starts it (`@j3-bots/processes`): by its
// full path under `SystemRoot`, never looked up on the search path the
// operator's shell set, without a profile, and with the script as
// `-EncodedCommand`, so nothing in it is quoted for a command line. Values
// reach the script as environment variables, never in its text.

/** PowerShell could not be started, or the script failed. */
class PowerShellFailed extends Schema.TaggedError<PowerShellFailed>()("PowerShellFailed", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Windows PowerShell failed: ${this.detail}`;
  }
}

/** How long a script gets before it is stopped: PowerShell takes about a second to start. */
const RUN_WITHIN = "30 seconds";

/**
 * Runs `script` with `variables` added to this process's environment (but
 * `PSModulePath`), and answers what it wrote to its output. A script that
 * fails, or that runs past its time, fails with what it wrote to its error
 * output.
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
        ChildProcess.make(system32(environment, POWERSHELL), powerShellArgs(script), {
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
