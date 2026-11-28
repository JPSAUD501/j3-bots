// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PageHost } from "@j3-bots/browser";
import type { BrowserHostStatus, EngineStatus } from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import { ServerConfig } from "../../config.ts";
import { Layout } from "../../Layout.ts";
import { Host } from "../../system/Host.ts";
import { chromePlatformOf, ensureChrome } from "./chrome.ts";
import type { BrowserHostNeeds } from "./hostNeeds.ts";
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
    /**
     * Whether the browser can run on this host, now and on every change:
     * checked as the server starts and after each start of the browser,
     * which may download it or find its sandbox blocked. Always ready off
     * Linux, where it needs no setup; none in local mode.
     */
    readonly hostStatus: Stream.Stream<Option.Option<BrowserHostStatus>>;
  }
>()("@j3-bots/server/browser/server/ServerBrowser") {}

/**
 * The engine's status as clients get it, with whether the server's own
 * browser can run here: the status's `browser` is the server's browser's.
 */
export const withBrowser = (
  status: EngineStatus,
  browser: Option.Option<BrowserHostStatus>,
): EngineStatus => {
  const { browser: _engine, ...rest } = status;
  return Option.match(browser, {
    onNone: () => rest,
    onSome: (current) => ({ ...rest, browser: current }),
  });
};

/** What the browser needs from this host, as the status says it. */
const hostStatusOf = (needs: BrowserHostNeeds): BrowserHostStatus => {
  const missing = [
    ...(needs.sandbox === "none" ? [] : (["sandbox"] as const)),
    ...(needs.missingLibraries.length > 0 ? (["libraries"] as const) : []),
    ...(needs.noFonts ? (["fonts"] as const) : []),
  ];
  return missing.length === 0 ? { _tag: "ready" } : { _tag: "setup-required", needs: missing };
};

/** The pinned Chrome for Testing, under the server's home. */
export const layer = Layer.effect(
  ServerBrowser,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const files = yield* Layout;
    const client = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* Host;
    const platform = chromePlatformOf(process.platform, process.arch);
    // Set by the desktop app for the server it starts on the person's own
    // computer: there, tabs run only in the app.
    const off = Option.isSome(
      yield* Config.option(Config.Literal("off", "J3_BROWSER_SERVER_HOST")),
    );

    /**
     * Whether the browser found its sandbox blocked when it last started,
     * until it next starts: what the files the host check reads cannot show
     * without root (`SandboxBlock`).
     */
    const sandboxRefused = yield* Ref.make(false);
    const hostStatus = yield* SubscriptionRef.make(Option.none<BrowserHostStatus>());
    const checkHost = Effect.gen(function* () {
      if (off) return;
      if (host.platform !== "linux") {
        return yield* SubscriptionRef.set(hostStatus, Option.some({ _tag: "ready" }));
      }
      const needs = yield* host.browserNeeds({
        home,
        sandboxRefused: yield* Ref.get(sandboxRefused),
      });
      yield* SubscriptionRef.set(hostStatus, Option.some(hostStatusOf(needs)));
    });
    yield* Effect.forkScoped(checkHost);
    /** Checks the host again once a start of the browser shows what it lacked, or that it lacks nothing. */
    const learnStart = (refusedSandbox: boolean) =>
      Ref.set(sandboxRefused, refusedSandbox).pipe(Effect.andThen(checkHost));

    return ServerBrowser.of({
      hostStatus: SubscriptionRef.changes(hostStatus),
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
          Effect.tap(() => learnStart(false)),
          Effect.tapError((cause) =>
            cause.reason === "other" ? Effect.void : learnStart(cause.reason === "sandbox"),
          ),
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
