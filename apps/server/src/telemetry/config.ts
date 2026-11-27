// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TelemetryArch, TelemetryInstallKind, TelemetryOs } from "@j3-bots/contracts";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import * as Installation from "../installation.ts";
import * as Host from "../system/Host.ts";
import * as Systemd from "../system/Systemd.ts";
import { updateHost } from "../update/host.ts";
import { telemetryEnvironment, unreadableOptOut } from "./environment.ts";
import { type ServerDimensions, TelemetryConfig } from "./Telemetry.ts";

const osFamily = (platform: string): TelemetryOs => {
  switch (platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "android":
      return "android";
    default:
      return "other";
  }
};

const archFamily = (arch: string): TelemetryArch =>
  arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : "other";

/**
 * How the server runs, as its updates tell it: the desktop app's, a
 * checkout's, one its service runs (whether or not it can update itself),
 * or one started by hand.
 */
const installKind = (home: string, started: "desktop" | "cli") =>
  updateHost({ home, started, release: {} }).pipe(
    Effect.map((host): TelemetryInstallKind => {
      if (host._tag === "service") return "service";
      switch (host.reason) {
        case "desktop-managed":
          return "desktop";
        case "checkout":
          return "development";
        case "unpacked":
        case "started-by-hand":
          return "manual";
        default:
          return "service";
      }
    }),
  );

/**
 * The server's telemetry configuration: what its environment allows, and
 * what it says about itself, read once. `started` is `desktop` when the
 * desktop app runs it.
 */
export const layer = (started: "desktop" | "cli") =>
  Layer.effect(
    TelemetryConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const installation = yield* Effect.result(Installation.installation);
      const development =
        installation._tag === "Success" && installation.success.layout._tag === "checkout";
      const variables = yield* Effect.sync(() => process.env);
      const environment = telemetryEnvironment(variables, development);
      if (unreadableOptOut(variables)) {
        yield* Effect.logWarning(
          "J3_TELEMETRY_ENABLED is neither a yes nor a no, so usage data stays off",
        );
      }
      if (environment.hold !== null) {
        yield* Effect.logInfo("Usage data is off for this server", { reason: environment.hold });
      }
      const context = yield* Effect.context<
        | Host.Host
        | Systemd.Systemd
        | FileSystem.FileSystem
        | Path.Path
        | ChildProcessSpawner.ChildProcessSpawner
      >();
      const server = Effect.gen(function* () {
        return {
          j3Version: packageJson.version,
          engineVersion: Option.isNone(config.engineBinary) ? EngineLive.pinnedRelease : null,
          os: osFamily(process.platform),
          arch: archFamily(process.arch),
          // A service manager that does not answer leaves it `manual` rather than hold a send.
          installKind: yield* installKind(config.home, started).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () => Effect.succeed<TelemetryInstallKind>("manual"),
            }),
          ),
        } satisfies ServerDimensions;
      }).pipe(Effect.provideContext(context), Effect.cached);
      return TelemetryConfig.of({ environment, server: yield* server });
    }),
  ).pipe(Layer.provide(Layer.merge(Systemd.layer, Host.layer)));
