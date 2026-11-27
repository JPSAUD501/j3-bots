// SPDX-License-Identifier: AGPL-3.0-or-later
import { packageLauncher, pinRefusal } from "@j3-bots/contracts";
import type { PriorDiscovery } from "@modelcontextprotocol/client";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { CommandFailed, type ConnectorFailure, NotMcp, ResponseTooLarge } from "../errors.ts";
import {
  type ClientSetup,
  type McpSession,
  makeClient,
  request,
  type SessionLimits,
  scrubberOf,
  sdkTimeout,
  sessionOf,
} from "../session.ts";
import { type CommandVariable, commandEnvironment, launcherSettings } from "./environment.ts";
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

export interface CommandSessionOptions extends ClientSetup {
  readonly platform: NodeJS.Platform;
  /** The program as the operator gave it: a name to find on the search path, or a path. */
  readonly program: string;
  readonly args: ReadonlyArray<Redacted.Redacted<string>>;
  /** The variables the operator gave it, with their values from the secrets. */
  readonly variables: ReadonlyArray<CommandVariable>;
  /**
   * Values of the operator's secrets its arguments and variables carry: its
   * answers are scrubbed of them, as of its variables' values, and of a short
   * one where it stands as a word of its own (`scrubberOf`).
   */
  readonly hidden: ReadonlyArray<Redacted.Redacted<string>>;
  /**
   * Other values its arguments and variables carry, not known to be secrets,
   * as a login's user name: scrubbed as its variables' values are.
   */
  readonly carried: ReadonlyArray<Redacted.Redacted<string>>;
  /** The server's own environment, of which only a few variables reach the process. */
  readonly serverEnvironment: Readonly<Record<string, string | undefined>>;
  /** The folder the process runs in, and a relative program is found from. */
  readonly cwd: string;
  /**
   * The folder an npm launcher runs in instead: the server's own, which holds
   * only an empty `package.json`, so npm takes it for the project and reads
   * no project's `.npmrc`, nor runs a package a project installed.
   */
  readonly launcherFolder: string;
  readonly limits: SessionLimits;
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
 * its credentials, and of the secrets' values its arguments carry
 * (`hidden`). Its other arguments are not: they are the command's own words,
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
      return yield* new CommandFailed({ reason: "refused" });
    }
    if (interpreterReads(options.platform, executable, args)) {
      yield* Effect.logWarning(
        "A command's arguments would be read by Windows' command interpreter",
      );
      return yield* new CommandFailed({ reason: "refused" });
    }
    if (debugsChildren(options.serverEnvironment)) {
      yield* Effect.logWarning(
        "Command connectors do not start while NODE_DEBUG logs what child processes are given",
      );
      return yield* new CommandFailed({ reason: "exited" });
    }
    const launcher = packageLauncher(executable, args);
    const started = Option.match(launcher, {
      onNone: () => ({ environment, cwd: options.cwd }),
      onSome: (name) => ({
        environment: { ...environment, ...launcherSettings(options.platform, name) },
        cwd: name === "npm" ? options.launcherFolder : options.cwd,
      }),
    });
    const scrub = scrubberOf(
      [...options.variables.map((variable) => variable.value), ...options.carried].map(
        Redacted.value,
      ),
      options.hidden.map(Redacted.value),
    );
    const context = yield* Effect.context<never>();
    const fork = (effect: Effect.Effect<void>) => void Effect.runForkWith(context)(effect);

    /** Starts the process and connects to it, as `prior` says or by asking it which revision it speaks. */
    const connect = Effect.fn("openCommandSession.connect")(function* (
      prior: PriorDiscovery | undefined,
    ) {
      const running = yield* startProcess({
        platform: options.platform,
        executable,
        args,
        environment: started.environment,
        cwd: started.cwd,
      });
      const broken = yield* Deferred.make<void>();
      const transport = new ProcessTransport(
        running.pid,
        running.input,
        running.output,
        MAX_MESSAGE_BYTES,
        () => fork(Deferred.succeed(broken, undefined)),
      );
      const client = makeClient(options, limits, fork);

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
       * A failure as the process explains it: one that came because it
       * ended is its ending, and one because a message was too long is
       * that. One that does not read what it is sent is not speaking MCP.
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
            client.connect(transport, {
              signal,
              timeout: sdkTimeout(limits.listDeadline),
              ...(prior === undefined ? {} : { prior }),
            }),
          ).pipe(
            // A process that ends under the handshake may be heard of after the
            // handshake fails: its ending is what failed it.
            Effect.catch((failure) =>
              running.ended.pipe(
                Effect.as<ConnectorFailure>(new CommandFailed({ reason: "exited" })),
                Effect.timeoutOrElse({
                  duration: Duration.seconds(1),
                  orElse: () => Effect.succeed(failure),
                }),
                Effect.flatMap(Effect.fail),
              ),
            ),
          ),
        ),
        () =>
          Effect.promise(() => client.close().catch(() => undefined)).pipe(
            Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.void }),
          ),
      );

      const session = sessionOf(client, transport, limits, context, () => scrub);
      return {
        session: {
          info: session.info,
          listTools: explained(session.listTools),
          listResources: explained(session.listResources),
          listPrompts: explained(session.listPrompts),
          callTool: (input) => explained(session.callTool(input)),
          readResource: (input) => explained(session.readResource(input)),
          readAppResource: (uri, maxBytes) => explained(session.readAppResource(uri, maxBytes)),
          getPrompt: (input) => explained(session.getPrompt(input)),
          skills: {
            ...session.skills,
            listSkills: explained(session.skills.listSkills),
            getSkill: (uri) => explained(session.skills.getSkill(uri)),
            readSkillFile: (skill, path) => explained(session.skills.readSkillFile(skill, path)),
            listSkillFolder: (skill, path) =>
              explained(session.skills.listSkillFolder(skill, path)),
          },
        },
        ended: Effect.raceFirst(running.ended, Deferred.await(broken)),
      } satisfies CommandSession;
    });

    // A server built on an SDK that predates 2026-07-28 may end at the first
    // request it does not know, as `server/discover` is to it: such a server
    // is started again and spoken to as it expects.
    const scope = yield* Effect.scope;
    const attempt = yield* Scope.fork(scope);
    const first = yield* connect(undefined).pipe(Scope.provide(attempt), Effect.exit);
    if (Exit.isSuccess(first)) return first.value;
    yield* Scope.close(attempt, first);
    const exited = Option.match(Exit.findErrorOption(first), {
      onNone: () => false,
      onSome: (failure) => failure._tag === "CommandFailed",
    });
    if (!exited) return yield* first;
    return yield* connect({ kind: "legacy" });
  });
