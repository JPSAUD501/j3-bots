// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";
import * as ServerStop from "../ServerStop.ts";
import * as Stdin from "../system/Stdin.ts";
import { refuse, userFacing } from "./errors.ts";

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
        userFacing(Layer.build(Server.layer({ adminFd }))).pipe(Effect.andThen(Effect.never)),
        stop.requested,
      );
    }).pipe(Effect.scoped, Effect.provide(ServerStop.layer)),
  ),
);
