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

/**
 * Variables that configure T3 Code or a harness it runs: Claude Code's and
 * Anthropic's (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_AUTH_TOKEN`), Codex's and
 * OpenAI's (`CODEX_HOME`, `OPENAI_API_KEY`), and T3 Code's own (`T3CODE_HOME`,
 * `T3_BOOT_SERVICE_UNIT`).
 */
const HARNESS_CONFIGURATION = /^(ANTHROPIC_|CLAUDE|OPENAI_|CODEX_|T3CODE_|T3_)/;

/**
 * The environment the engine starts with: the server's, without what
 * configures T3 Code or a harness. The engine passes its environment on to
 * every harness it starts, so a server started from the operator's shell
 * would otherwise give bots the operator's own provider credentials, config
 * folders or T3 Code service. A bot's harness is configured only by what J3
 * Bots provisions.
 */
export const engineEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(parent).flatMap(([name, value]) =>
      value === undefined || HARNESS_CONFIGURATION.test(name) ? [] : [[name, value]],
    ),
  );
