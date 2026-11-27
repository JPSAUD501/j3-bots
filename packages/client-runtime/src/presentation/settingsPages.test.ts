// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providersNeedYou } from "./settingsPages.ts";

const provider = (id: string, status: ProviderStatus["status"]): ProviderStatus => ({
  id: ProviderId.make(id),
  name: id,
  harness: "claude-code",
  status,
  models: [{ id: ModelId.make("m"), name: "Model", efforts: [] }],
  usage: [],
});

const engine = (
  state: EngineStatus["state"],
  ...providers: ReadonlyArray<ProviderStatus>
): EngineStatus => ({ state, pinnedVersion: "0.1.11", providers });

const ready = { _tag: "ready" } as const;
const signedOut = { _tag: "sign-in-required", command: "j3-bots provider connect" } as const;
const notInstalled = { _tag: "unavailable", checking: false, reason: "not-installed" } as const;

describe("providersNeedYou", () => {
  it("waits on the operator when the engine cannot run, not while it starts", () => {
    expect(providersNeedYou(engine({ _tag: "unavailable", reason: "port-in-use" }))).toBe(true);
    expect(providersNeedYou(engine({ _tag: "incompatible", runningVersion: "0.1.9" }))).toBe(true);
    expect(providersNeedYou(engine({ _tag: "starting" }))).toBe(false);
  });

  it("waits on the operator only while no provider can run a bot", () => {
    expect(providersNeedYou(engine(ready, provider("claude", signedOut)))).toBe(true);
    // One provider left out while another runs the bots is a choice, not a problem.
    expect(
      providersNeedYou(engine(ready, provider("claude", ready), provider("codex", notInstalled))),
    ).toBe(false);
    // Still being checked: it may turn out ready.
    expect(
      providersNeedYou(engine(ready, provider("claude", { _tag: "unavailable", checking: true }))),
    ).toBe(false);
  });
});
