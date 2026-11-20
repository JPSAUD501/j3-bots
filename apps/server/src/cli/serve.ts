// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { userFacing } from "./errors.ts";

export const serveCommand = Command.make("serve").pipe(
  Command.withDescription(
    "Run the J3 Bots server in this terminal. The service runs this; stop it with Ctrl+C.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      // Loaded on demand: the other commands start faster without the server.
      const Server = yield* Effect.promise(() => import("../server.ts"));
      return yield* userFacing(Layer.launch(Server.layer));
    }),
  ),
);
