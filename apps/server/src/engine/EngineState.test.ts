// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import { defaultModelIn } from "./EngineState.ts";

const provider = (
  id: string,
  status: ProviderStatus["status"],
  models: ReadonlyArray<string>,
): ProviderStatus => ({
  id: ProviderId.make(id),
  name: id,
  harness: id === "codex" ? "codex" : "claude-code",
  status,
  models: models.map((model) => ({ id: ModelId.make(model), name: model })),
  usage: [],
});

const engineWith = (...providers: ReadonlyArray<ProviderStatus>): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers,
});

const unavailable = (reason: "not-installed" | "failed" | "disabled") =>
  ({ _tag: "unavailable", checking: false, reason }) as const;

describe("defaultModelIn", () => {
  it("gives a new bot a model of a harness still to be installed, so it is made while its AI downloads", () => {
    const status = engineWith(
      provider("claude-code", unavailable("not-installed"), ["claude-sonnet-5-5"]),
      // Codex lists no model before it is connected.
      provider("codex", unavailable("not-installed"), []),
    );
    assert.deepStrictEqual(
      defaultModelIn(status),
      Option.some({
        providerId: ProviderId.make("claude-code"),
        modelId: ModelId.make("claude-sonnet-5-5"),
      }),
    );
  });

  it("prefers a provider a sign-in connects to one still to be installed", () => {
    const status = engineWith(
      provider("claude-code", unavailable("not-installed"), ["claude-sonnet-5-5"]),
      provider("codex", { _tag: "sign-in-required", command: "j3-bots provider connect" }, [
        "gpt-6.2",
      ]),
    );
    assert.deepStrictEqual(
      Option.map(defaultModelIn(status), (model) => model.providerId),
      Option.some(ProviderId.make("codex")),
    );
  });

  it("gives none on a harness the engine found and cannot run, which nothing is bringing", () => {
    for (const reason of ["failed", "disabled"] as const) {
      const status = engineWith(
        provider("claude-code", unavailable(reason), ["claude-sonnet-5-5"]),
      );
      assert.deepStrictEqual(defaultModelIn(status), Option.none());
    }
  });
});
