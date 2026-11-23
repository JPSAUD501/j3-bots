// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// The short commands the app runs to learn something of the system: the
// operator's login shell for its PATH, PowerShell for a process's
// executable, `ps` for a process's start. None may hold the app up, its quit
// included, whatever the command does.

/** How long a probe past its deadline has, after SIGTERM, before SIGKILL. */
const STOP_WITHIN = Duration.seconds(2);

export interface ProbeOptions {
  /** How long it may run. */
  readonly deadline: Duration.Input;
  /** Its whole environment; the app's own when not given. */
  readonly env?: Record<string, string>;
}

const run = Effect.fn("Probe.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> | undefined,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, [...args], {
      ...(env === undefined ? {} : { env, extendEnv: false }),
      stdin: "ignore",
      stderr: "ignore",
      windowsHide: true,
      // The spawner's own default waits for a process it ends without
      // limit: one that ignores SIGTERM, as a login shell whose profile
      // traps it may, would never let the probe end.
      killSignal: "SIGTERM",
      forceKillAfter: STOP_WITHIN,
    }),
  );
  return yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString);
}, Effect.scoped);

/**
 * What `command` printed, or none when it did not start, failed, or did not
 * finish by its deadline. One that outlives the deadline gets SIGTERM, then
 * SIGKILL `STOP_WITHIN` later, and the probe ends then.
 */
export const outputOf = Effect.fn("Probe.outputOf")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: ProbeOptions,
) {
  return yield* run(command, args, options.env).pipe(
    Effect.timeoutOption(options.deadline),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
