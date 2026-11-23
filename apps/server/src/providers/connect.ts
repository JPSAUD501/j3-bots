// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderConnectionOutcome, ProviderConnectionRequest } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { RunningWork } from "../turns/RunningWork.ts";
import { SendPause } from "../turns/SendPause.ts";

/**
 * Connects Claude Code and Codex to the endpoint `request` names, for
 * `j3-bots provider connect` over the admin socket and `provider.connect`
 * from a client alike: unless the request agreed to stop the work bots have
 * running, nothing is stored while any runs. No new work starts between that
 * check and the engine's restart: first sends wait until the engine is back,
 * or the connection was refused. The key goes to the engine's secret store
 * only, redacted on the way.
 */
export const connectProviders = Effect.fn("providers.connect")(function* (
  request: ProviderConnectionRequest,
) {
  const runningWork = yield* RunningWork;
  const engine = yield* Engine;
  return yield* (yield* SendPause).paused(
    Effect.gen(function* () {
      const working = request.stopWork ? [] : yield* runningWork.bots;
      return working.length > 0
        ? ({ _tag: "work-running", bots: working.length } satisfies ProviderConnectionOutcome)
        : yield* engine.connectProviders({
            baseUrl: request.baseUrl,
            key: Redacted.make(request.key),
          });
    }),
  );
});
