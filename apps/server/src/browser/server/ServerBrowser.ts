// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PageHost } from "@j3-bots/browser";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import { ServerConfig } from "../../config.ts";
import { Layout } from "../../Layout.ts";
import { chromePlatformOf, ensureChrome } from "./chrome.ts";
import { launchServerHost } from "./ServerHost.ts";

/**
 * Why the server's own browser cannot run:
 *
 * - `sandbox`, `libraries`: the host must be set up first; `j3-bots doctor`
 *   says how.
 * - `download`: the pinned Chrome for Testing could not be downloaded or
 *   was not the pinned one.
 * - `platform`: Chrome for Testing has no build for this system.
 * - `failed`: it would not start, for another reason.
 * - `off`: this server runs no browser of its own: the desktop app that
 *   started it set `J3_BROWSER_SERVER_HOST=off` (local mode, decision 0110).
 */
export class ServerBrowserUnavailable extends Schema.TaggedError<ServerBrowserUnavailable>()(
  "ServerBrowserUnavailable",
  {
    reason: Schema.Literals(["sandbox", "libraries", "download", "platform", "failed", "off"]),
  },
) {}

/** The server's own browser, started when a tab needs it (decision 0110). */
export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    /**
     * Starts the browser, downloading it first on its first use, for as long
     * as the scope lives. It runs a page host with no tab yet.
     */
    readonly launch: Effect.Effect<
      PageHost & { readonly tabCount: Effect.Effect<number> },
      ServerBrowserUnavailable,
      Scope.Scope
    >;
  }
>()("@j3-bots/server/browser/server/ServerBrowser") {}

/** The pinned Chrome for Testing, under the server's home. */
export const layer = Layer.effect(
  ServerBrowser,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const files = yield* Layout;
    const client = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = chromePlatformOf(process.platform, process.arch);
    // Set by the desktop app for the server it starts on the person's own
    // computer: there, tabs run only in the app.
    const off = Option.isSome(
      yield* Config.option(Config.Literal("off", "J3_BROWSER_SERVER_HOST")),
    );
    return ServerBrowser.of({
      launch: Effect.gen(function* () {
        if (off) return yield* new ServerBrowserUnavailable({ reason: "off" });
        if (Option.isNone(platform))
          return yield* new ServerBrowserUnavailable({ reason: "platform" });
        const executable = yield* ensureChrome({
          home,
          platform: platform.value,
          files,
          client,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.tapError((cause) =>
            Effect.logWarning("The server's browser is not installed", cause),
          ),
          Effect.mapError(
            (cause) =>
              new ServerBrowserUnavailable({
                reason: cause.reason === "platform" ? "platform" : "download",
              }),
          ),
        );
        return yield* launchServerHost({ executable, platform: platform.value }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.tapError((cause) =>
            Effect.logWarning("The server's browser did not start", cause),
          ),
          Effect.mapError(
            (cause) =>
              new ServerBrowserUnavailable({
                reason: cause.reason === "other" ? "failed" : cause.reason,
              }),
          ),
        );
      }),
    });
  }),
);
