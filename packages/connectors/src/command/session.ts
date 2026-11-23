// SPDX-License-Identifier: AGPL-3.0-or-later
import { Client } from "@modelcontextprotocol/client";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { CommandFailed, type ConnectorFailure, NotMcp, ResponseTooLarge } from "../errors.ts";
import {
  type McpSession,
  request,
  type SessionLimits,
  scrubberOf,
  sdkTimeout,
  toolsOf,
} from "../session.ts";
import { type CommandVariable, commandEnvironment } from "./environment.ts";
import { startProcess } from "./process.ts";
import { interpreterReads, resolveProgram } from "./program.ts";
import { ProcessTransport } from "./transport.ts";

/**
 * An MCP session with a command connector's server: its process, started
 * from the command line the operator confirmed, and MCP over its standard
 * streams. One process serves every bot that uses the connector; the
 * supervisor (`supervisor.ts`) decides when it starts and stops.
 */

/** The most one message from the process may take, in bytes, as the SDK's stdio transport allows. */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

export interface CommandSessionOptions {
  readonly platform: NodeJS.Platform;
  /** The program as the operator gave it: a name to find on the search path, or a path. */
  readonly program: string;
  readonly args: ReadonlyArray<Redacted.Redacted<string>>;
  /** The variables the operator gave it, with their values from the vault. */
  readonly variables: ReadonlyArray<CommandVariable>;
  /** The server's own environment, of which only a few variables reach the process. */
  readonly serverEnvironment: Readonly<Record<string, string | undefined>>;
  /** The folder the process runs in. */
  readonly cwd: string;
  readonly limits: SessionLimits;
  readonly client: { readonly name: string; readonly version: string };
  /** The server said its tools changed (`notifications/tools/list_changed`). */
  readonly onToolsChanged: Effect.Effect<void>;
}

export interface CommandSession {
  readonly session: McpSession;
  /** Done once the process has ended, by itself or by the session's close. */
  readonly ended: Effect.Effect<void>;
}

/**
 * Starts the process and opens the MCP session with it, within the list
 * deadline. The session closes, and the process stops with everything it
 * started, when the scope closes.
 *
 * What the process answers is scrubbed of the values of its environment the
 * operator gave, should it echo one, as a remote server's answers are of
 * its credentials. Its arguments are not: they are the command's own words,
 * such as a folder it serves, which its answers name as a matter of course.
 */
export const openCommandSession = (
  options: CommandSessionOptions,
): Effect.Effect<CommandSession, ConnectorFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const { limits } = options;
    const environment = commandEnvironment(
      options.platform,
      options.serverEnvironment,
      options.variables,
    );
    const executable = yield* resolveProgram({
      platform: options.platform,
      program: options.program,
      environment,
      cwd: options.cwd,
    });
    const args = options.args.map(Redacted.value);
    if (interpreterReads(options.platform, executable, args)) {
      yield* Effect.logWarning(
        "A command's arguments would be read by Windows' command interpreter",
      );
      return yield* new CommandFailed({ reason: "exited" });
    }
    const running = yield* startProcess({
      platform: options.platform,
      executable,
      args,
      environment,
      cwd: options.cwd,
    });
    const transport = new ProcessTransport(running.input, running.output, MAX_MESSAGE_BYTES);
    const fork = Effect.runForkWith(yield* Effect.context<never>());
    const client = new Client(options.client, {
      capabilities: {},
      listChanged: {
        tools: { autoRefresh: false, debounceMs: 0, onChanged: () => fork(options.onToolsChanged) },
      },
    });

    let ended = false;
    yield* running.ended.pipe(
      Effect.andThen(
        Effect.sync(() => {
          ended = true;
        }),
      ),
      Effect.forkScoped,
    );
    /**
     * A failure as the process explains it: one that came because it ended
     * is its ending, and one because a message was too long is that. One
     * that does not read what it is sent is not speaking MCP.
     */
    const explained = <A>(effect: Effect.Effect<A, ConnectorFailure>) =>
      effect.pipe(
        Effect.mapError((failure): ConnectorFailure =>
          transport.tooLarge
            ? new ResponseTooLarge({ limit: MAX_MESSAGE_BYTES })
            : transport.stalled
              ? new NotMcp()
              : ended || failure._tag === "Unreachable"
                ? new CommandFailed({ reason: "exited" })
                : failure,
        ),
      );

    yield* Effect.acquireRelease(
      explained(
        request(limits.listDeadline, (signal) =>
          client.connect(transport, { signal, timeout: sdkTimeout(limits.listDeadline) }),
        ),
      ),
      () =>
        Effect.promise(() => client.close().catch(() => undefined)).pipe(
          Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.void }),
        ),
    );

    const scrub = scrubberOf(options.variables.map((variable) => Redacted.value(variable.value)));
    const tools = toolsOf(client, limits, () => scrub);
    return {
      session: {
        listTools: explained(tools.listTools),
        callTool: (input) => explained(tools.callTool(input)),
      },
      ended: running.ended,
    } satisfies CommandSession;
  });
