// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Duration from "effect/Duration";
import * as ChildProcess from "effect/process/ChildProcess";

/** How long a short command (unpacking the engine, minting a credential, `ps`) gets to stop. */
const SHORT_COMMAND_STOP = "2 seconds";

/**
 * A command the adapter runs. When its scope closes while it still runs, as
 * on the server's stop, it gets SIGTERM and then, once `stopWithin` has
 * passed, SIGKILL: a child that ignores SIGTERM never holds the stop up. The
 * spawner's own default would wait for it without limit.
 */
export const boundedCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  options: Omit<ChildProcess.CommandOptions, keyof ChildProcess.KillOptions> = {},
  stopWithin: Duration.Input = SHORT_COMMAND_STOP,
) =>
  ChildProcess.make(executable, args, {
    ...options,
    killSignal: "SIGTERM",
    forceKillAfter: stopWithin,
  });
