// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Home from "../home/Home.ts";
import * as Layout from "../Layout.ts";
import { ServerConfig } from "../config.ts";
import { userFacing } from "./errors.ts";

const fetchCommand = Command.make("fetch").pipe(
  Command.withDescription(
    "Download and install the engine this release is pinned to, if it is not installed yet, without starting it. The server does this on its first start; fetching first lets a new release start without waiting for the download. Safe while the server runs.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const layout = yield* Layout.Layout;
      yield* Console.log(`Installing T3 Code, the engine, into ${config.engineHome}…`);
      const fetched = yield* userFacing(
        EngineLive.fetchPinned({
          home: config.engineHome,
          isPrivate: (location) => layout.writable(location).pipe(Effect.isSuccess),
        }),
      );
      yield* Console.log(
        fetched.alreadyInstalled
          ? `T3 Code ${fetched.version} was already installed: ${fetched.executable}`
          : `T3 Code ${fetched.version} is installed: ${fetched.executable}`,
      );
    }).pipe(
      // The home as the server would start with it, created if this is its first use.
      Effect.provide(
        Layout.layer.pipe(
          Layer.provideMerge(Layer.effect(ServerConfig, userFacing(Home.initialize))),
          Layer.provideMerge(FetchHttpClient.layer),
        ),
      ),
    ),
  ),
);

export const engineCommand = Command.make("engine").pipe(
  Command.withDescription(
    "The engine J3 Bots runs bots on: T3 Code, at the version it is pinned to.",
  ),
  Command.withSubcommands([fetchCommand]),
);
