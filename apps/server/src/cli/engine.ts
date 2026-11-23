// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import { Command } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Home from "../home/Home.ts";
import * as Layout from "../Layout.ts";
import { ServerConfig } from "../config.ts";
import { userFacing } from "./errors.ts";

/**
 * How the download reaches whoever runs `engine fetch`, as
 * "Downloading the engine: 42 of 180 MB" and then "Downloaded the engine:
 * 180 MB": on a terminal, one line rewritten as the download goes; elsewhere,
 * as when `j3-bots update` relays it, a line now and then
 * (`makeProgressLog`). `done` ends the rewritten line.
 */
const progressPrinter = Effect.fn("engine.progressPrinter")(function* () {
  const terminal = yield* Terminal.Terminal;
  const inPlace = yield* (yield* Stdio.Stdio).stdoutIsTerminal;
  const log = yield* EngineLive.makeProgressLog();
  const shown = yield* Ref.make(false);
  const onDownload = (event: EngineLive.DownloadEvent) =>
    inPlace
      ? Ref.set(shown, true).pipe(
          Effect.andThen(
            // Back to the line's start, then the line, then clear what a longer one left.
            terminal.display(`\r${EngineLive.downloadText(event)}\u001b[K`),
          ),
          Effect.ignore,
        )
      : log(event).pipe(
          Effect.flatMap((line) => (Option.isSome(line) ? Console.log(line.value) : Effect.void)),
        );
  const done = Effect.gen(function* () {
    if (yield* Ref.get(shown)) yield* terminal.display("\n").pipe(Effect.ignore);
  });
  return { onDownload, done };
});

const fetchCommand = Command.make("fetch").pipe(
  Command.withDescription(
    "Download and install the engine this release is pinned to, if it is not installed yet, without starting it. The server does this on its first start; fetching first lets a new release start without waiting for the download.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const layout = yield* Layout.Layout;
      yield* Console.log(`Installing T3 Code, the engine, into ${config.engineHome}…`);
      const progress = yield* progressPrinter();
      const fetched = yield* userFacing(
        EngineLive.fetchPinned({
          home: config.engineHome,
          isPrivate: (location) => layout.writable(location).pipe(Effect.isSuccess),
          onDownload: progress.onDownload,
        }),
      ).pipe(Effect.ensuring(progress.done));
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
