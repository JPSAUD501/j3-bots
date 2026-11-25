// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SignInHarness } from "@j3-bots/contracts";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ServerConfig } from "../config.ts";
import { HARNESSES } from "../engine/harnesses.ts";
import { homeLayout } from "../home/entries.ts";
import { Host } from "../system/Host.ts";
import { type Distribution, distributions } from "./distributions.ts";
import { type Probe, versionIn } from "./install.ts";

/** How long a new copy gets to say its version. */
const PROBE_TIMEOUT = "30 seconds";

/**
 * Where J3 Bots' copies of the harnesses come from, and how a new one is run
 * once to check it: the makers' distributions and this machine's processes
 * in `layer`, fakes in tests.
 */
export class HarnessSources extends Context.Service<
  HarnessSources,
  {
    readonly platform: string;
    readonly distributions: Readonly<Record<SignInHarness, Distribution>>;
    readonly probe: (harness: SignInHarness) => Probe;
  }
>()("@j3-bots/server/harnesses/sources/HarnessSources") {}

/**
 * The makers' distributions, read over the network, and a probe that runs
 * `<executable> --version` as the engine would run the harness: with the
 * variables the engine passes on, and the harness's configuration folder
 * set to its J3-owned home, so it never reads the operator's own.
 */
export const layer = Layer.effect(
  HarnessSources,
  Effect.gen(function* () {
    const host = yield* Host;
    const client = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const { home } = yield* ServerConfig;
    const base = EngineLive.engineEnvironment(yield* Effect.sync(() => process.env), host.platform);
    const probe =
      (harness: SignInHarness): Probe =>
      (executable) =>
        spawner
          .string(
            ChildProcess.make(executable, ["--version"], {
              stdin: "ignore",
              env: {
                ...base,
                [HARNESSES[harness].homeVariable]: homeLayout(path, home).providerHome(harness),
                // A copy of J3 Bots' is updated by J3 Bots, never by itself.
                ...(harness === "claude-code" ? { DISABLE_AUTOUPDATER: "1" } : {}),
              },
              extendEnv: false,
              killSignal: "SIGTERM",
              forceKillAfter: "2 seconds",
            }),
          )
          .pipe(
            Effect.timeout(PROBE_TIMEOUT),
            Effect.map(versionIn),
            Effect.catch((cause) =>
              Effect.as(
                Effect.logWarning("A downloaded harness did not run", { cause }),
                Option.none(),
              ),
            ),
          );
    return HarnessSources.of({
      platform: host.platform,
      distributions: distributions(client, host),
      probe,
    });
  }),
);
