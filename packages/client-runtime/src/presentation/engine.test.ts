// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  ModelId,
  ProviderId,
  type ProviderStatus,
  type UnavailableReason,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providerFix, providerGate } from "./engine.ts";

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

describe("providerFix", () => {
  const unavailable = (reason?: UnavailableReason) =>
    ({ _tag: "unavailable", checking: false, ...(reason ? { reason } : {}) }) as const;

  it("installs a harness that is not there, from its maker's page, and retries one that failed", () => {
    expect(providerFix(provider("claude", unavailable("not-installed")))).toEqual({
      _tag: "install",
      page: "https://code.claude.com/docs/en/setup",
    });
    expect(
      providerFix({ ...provider("agent", unavailable("not-installed")), harness: "other" }),
    ).toEqual({ _tag: "install", page: null });
    expect(providerFix(provider("claude", unavailable("failed")))).toEqual({ _tag: "retry" });
  });

  it("offers nothing where no client can fix it, or the server cannot check again", () => {
    for (const status of [
      unavailable("disabled"),
      unavailable("unknown"),
      unavailable(),
      checking,
      signedOut,
      { _tag: "ready" } as const,
    ]) {
      expect(providerFix(provider("claude", status))).toBeNull();
    }
  });
});
