// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { CliError, Command, Flag } from "effect/cli";
import * as ServerStop from "../ServerStop.ts";
import { portStateOf } from "../system/Ports.ts";
import * as Stdin from "../system/Stdin.ts";
import { refuse } from "./errors.ts";

/**
 * The exit status of a start the server refused (sysexits' `EX_CONFIG`): its
 * configuration, its home or its database is not one this release may run
 * on, and a start with nothing changed is refused again. Whatever runs the
 * server (the desktop app) shows the message and does not start it again;
 * after any other failure it may.
 */
const START_REFUSED = 78;

/**
 * The failures of a start that only the operator can clear. A home another
 * server holds (`ServerAlreadyRunning`) is not one: that server may be one
 * still stopping, or an update copying the databases, and a later start
 * passes once it lets go.
 */
const REFUSALS: ReadonlySet<string> = new Set([
  "ConfigRefused",
  "ConfigFileInvalid",
  "ConfigFileUnreadable",
  "HomeNotPrivate",
  "HomeNotWritable",
  "HomeBlocked",
  "RollbackUnfinished",
]);

/**
 * Whether `error` refuses the start: one of `REFUSALS`; a database a newer
 * release migrated (the migrator's `BadState`); or a port the configuration
 * names that another program holds, that is not this machine's, or that this
 * user may not listen on (`Ports.ListenFailed`), none of which a start with
 * nothing changed would clear. A listen that failed otherwise may pass.
 */
const isRefusal = (error: { readonly _tag: string }) =>
  REFUSALS.has(error._tag) ||
  (error._tag === "MigrationError" &&
    Predicate.hasProperty(error, "kind") &&
    error.kind === "BadState") ||
  (error._tag === "ListenFailed" &&
    Predicate.hasProperty(error, "code") &&
    typeof error.code === "string" &&
    portStateOf(error.code)._tag !== "failed");

/** A start the server refused, shown as its own message and ended with `START_REFUSED`. */
class StartRefused extends Schema.TaggedError<StartRefused>()("StartRefused", {
  refusal: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = START_REFUSED;

  override get message(): string {
    return this.refusal;
  }

  override get [CliError.userMessage](): string {
    return this.refusal;
  }
}

/** How a start that failed with `error` ends: refused, or as any other failure. */
export const startFailure = (error: { readonly _tag: string; readonly message: string }) =>
  isRefusal(error)
    ? new StartRefused({ refusal: error.message })
    : new CliError.UserError({ cause: error, userMessage: error.message });

const adminFdFlag = Flag.Int("admin-fd").pipe(
  Flag.withDescription(
    'Also serve the admin channel on this inherited file descriptor: the server\'s end of a pipe from the process that started it, as Node\'s spawn makes one for a stdio entry of "pipe" or "overlapped". Start fails on a descriptor below 3, on a TCP socket, listening or connected, and, on Linux and macOS, on anything but a socket (a FIFO, a one-way pipe, a file or a terminal). For an app that runs its own server; it passes 3.',
  ),
  Flag.optional,
);

const exitWithStdinFlag = Flag.Boolean("exit-with-stdin").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Stop, as on SIGTERM, when stdin reaches its end: when the process that started the server closes it, or exits. For an app that runs its own server, so the server never outlives it.",
  ),
);

export const serveCommand = Command.make("serve", {
  adminFd: adminFdFlag,
  exitWithStdin: exitWithStdinFlag,
}).pipe(
  Command.withDescription(
    "Run the J3 Bots server in this terminal. The service runs this; stop it with Ctrl+C.",
  ),
  Command.withHandler(({ adminFd, exitWithStdin }) =>
    Effect.gen(function* () {
      // 0, 1 and 2 are stdin, stdout and stderr: never the admin channel.
      if (Option.isSome(adminFd) && adminFd.value < 3) {
        return yield* refuse(
          "--admin-fd takes a descriptor of 3 or more, a pipe the server inherited.",
        );
      }
      // Loaded on demand: the other commands start faster without the server.
      const Server = yield* Effect.promise(() => import("../server.ts"));
      const stop = yield* ServerStop.ServerStop;
      if (exitWithStdin) yield* Effect.forkScoped(Stdin.ended.pipe(Effect.andThen(stop.request)));
      // Released with the scope, as SIGINT and SIGTERM release it. A stop asked
      // for while it starts ends the start there.
      yield* Effect.raceFirst(
        Layer.build(Server.layer({ adminFd })).pipe(
          Effect.mapError(startFailure),
          Effect.andThen(Effect.never),
        ),
        stop.requested,
      );
    }).pipe(Effect.scoped, Effect.provide(ServerStop.layer)),
  ),
);
