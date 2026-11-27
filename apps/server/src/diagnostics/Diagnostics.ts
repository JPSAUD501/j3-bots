// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DiagnosticsClient } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Harnesses, withCopies } from "../harnesses/Harnesses.ts";
import { TelemetryConfig } from "../telemetry/Telemetry.ts";
import { BridgeKey } from "../tools/BridgeKey.ts";
import type { UpdateHost } from "../update/host.ts";
import { UpdateLauncher } from "../update/UpdateLauncher.ts";
import { diagnosticsZip, type InstallKind } from "./build.ts";

/** The running server's diagnostics zip, for a paired device that asks for one. */
export class Diagnostics extends Context.Service<
  Diagnostics,
  {
    /** The zip's bytes as they are made, for `client`, which asked for it. */
    readonly zip: (client: DiagnosticsClient) => Effect.Effect<Stream.Stream<Uint8Array>>;
  }
>()("@j3-bots/server/diagnostics/Diagnostics") {}

/** How the server is installed, from how it would update itself. */
const installKindOf = (host: UpdateHost): InstallKind => {
  if (host._tag === "service") return "service";
  switch (host.reason) {
    case "desktop-managed":
      return "desktop";
    case "checkout":
      return "checkout";
    case "unpacked":
    case "started-by-hand":
      return "release";
    case "no-systemd":
    case "no-linger":
    case "rollback-unfinished":
      return "service";
  }
};

export const layer = Layer.effect(
  Diagnostics,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const engine = yield* EngineState;
    const harnesses = yield* Harnesses;
    const launcher = yield* UpdateLauncher;
    const bridgeKey = yield* BridgeKey;
    const telemetry = yield* TelemetryConfig;
    const startedAt = yield* DateTime.now;
    const context = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | SqlClient.SqlClient
    >();
    return Diagnostics.of({
      zip: Effect.fn("Diagnostics.zip")(function* (client: DiagnosticsClient) {
        const status = yield* engine.current;
        const copies = yield* Stream.runHead(harnesses.copies);
        return yield* diagnosticsZip(config, {
          at: yield* DateTime.now,
          client: Option.some(client),
          version: packageJson.version,
          startedAt: Option.some(startedAt),
          install: installKindOf(yield* launcher.host),
          engine: Option.some(
            Option.match(copies, {
              onNone: () => status,
              onSome: (each) => withCopies(status, each),
            }),
          ),
          usageDataHold: Option.some(telemetry.environment.hold),
          secrets: [bridgeKey.variable.value],
        }).pipe(Effect.provide(context));
      }),
    });
  }),
);
