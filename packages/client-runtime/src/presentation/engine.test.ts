// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providerGate } from "./engine.ts";

const provider = (id: string, status: ProviderStatus["status"]): ProviderStatus => ({
  id: ProviderId.make(id),
  name: id,
  harness: "claude-code",
  status,
  models: [{ id: ModelId.make("m"), name: "Model" }],
  usage: [],
});

const engine = (...providers: ReadonlyArray<ProviderStatus>): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers,
});

const checking = { _tag: "unavailable", checking: true } as const;
const signedOut = { _tag: "sign-in-required", command: "j3-bots provider connect" } as const;

describe("providerGate", () => {
  it("waits for the engine's first check before saying a provider needs connecting", () => {
    expect(providerGate(engine(provider("claude", checking), provider("codex", checking)))).toEqual(
      { _tag: "checking" },
    );
    // The provider still being checked may turn out ready: connecting is not asked for yet.
    expect(
      providerGate(engine(provider("claude", checking), provider("codex", signedOut))),
    ).toEqual({ _tag: "checking" });
    expect(
      providerGate(
        engine(
          provider("claude", { _tag: "unavailable", checking: false }),
          provider("codex", signedOut),
        ),
      ),
    ).toEqual({ _tag: "connect", command: "j3-bots provider connect" });
  });

  it("lets the first bot be created once one provider can run it, while another is checked", () => {
    expect(
      providerGate(engine(provider("claude", { _tag: "ready" }), provider("codex", checking))),
    ).toEqual({ _tag: "ready" });
  });
});
