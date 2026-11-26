// SPDX-License-Identifier: AGPL-3.0-or-later
import { pinRefusal } from "@j3-bots/contracts";
import { Client } from "@modelcontextprotocol/client";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/**
 * Whether the server's Node writes what it starts a child with, arguments
 * and environment, to its standard error: `NODE_DEBUG` naming
 * `child_process`, by name or by a pattern with `*`, as Node reads it.
 */
const debugsChildren = (environment: Readonly<Record<string, string | undefined>>): boolean =>
  (environment["NODE_DEBUG"] ?? "")
    .split(/[\s,]+/)
    .filter((pattern) => pattern !== "")
    .some((pattern) =>
      new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
        "i",
      ).test("child_process"),
    );

export interface CommandSessionOptions {
  readonly platform: NodeJS.Platform;
  /** The program as the operator gave it: a name to find on the search path, or a path. */
  readonly program: string;
  readonly args: ReadonlyArray<Redacted.Redacted<string>>;
  /** The variables the operator gave it, with their values from the secrets. */
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
  /**
   * Done once the process has ended, by itself or by the session's close, or
   * once its session broke for its fault (a message too long, its input left
   * unread), when it is to be stopped.
   */
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
    // Checked again on the program as found, whatever way its path was written.
    const names = options.variables.map((variable) => variable.name);
    if (Option.isSome(pinRefusal(executable, args, names))) {
      yield* Effect.logWarning("A command runs a package launcher the version check refuses");
      return yield* new CommandFailed({ reason: "exited" });
    }
    if (interpreterReads(options.platform, executable, args)) {
      yield* Effect.logWarning(
        "A command's arguments would be read by Windows' command interpreter",
      );
      return yield* new CommandFailed({ reason: "exited" });
    }
    if (debugsChildren(options.serverEnvironment)) {
      yield* Effect.logWarning(
        "Command connectors do not start while NODE_DEBUG logs what child processes are given",
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
    const fork = Effect.runForkWith(yield* Effect.context<never>());
    const broken = yield* Deferred.make<void>();
    const transport = new ProcessTransport(running.input, running.output, MAX_MESSAGE_BYTES, () =>
      fork(Deferred.succeed(broken, undefined)),
    );
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
      ended: Effect.raceFirst(running.ended, Deferred.await(broken)),
    } satisfies CommandSession;
  });
