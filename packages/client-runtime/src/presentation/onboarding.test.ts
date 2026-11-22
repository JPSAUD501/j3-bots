// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makingProgress, nextStep, previousStep, showsConnect } from "./onboarding.ts";

const engine = (status: ProviderStatus["status"]): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers: [
    {
      id: ProviderId.make("claude"),
      name: "Claude Code",
      harness: "claude-code",
      status,
      models: [{ id: ModelId.make("m"), name: "Model" }],
      usage: [],
    },
  ],
});

const ready = engine({ _tag: "ready" });
const signedOut = engine({ _tag: "sign-in-required", command: "j3-bots provider connect" });

describe("the first run's steps", () => {
  it("goes from the look straight to the arrival when a provider can run the bot", () => {
    const connect = showsConnect(ready, "look");
    expect(nextStep("look", connect)).toBe("arrival");
    expect(makingProgress("look", connect)).toEqual({ index: 1, count: 2 });
  });

  it("asks to connect a provider before the arrival while none can run the bot", () => {
    const connect = showsConnect(signedOut, "look");
    expect(nextStep("look", connect)).toBe("connect");
    expect(nextStep("connect", connect)).toBe("arrival");
    expect(previousStep("connect", connect)).toBe("look");
  });

  it("keeps the connect step on screen when a provider connects while it is read", () => {
    const connect = showsConnect(ready, "connect");
    expect(nextStep("connect", connect)).toBe("arrival");
    expect(makingProgress("connect", connect)).toEqual({ index: 2, count: 3 });
  });

  it("asks to connect while the engine is not running", () => {
    expect(showsConnect({ ...ready, state: { _tag: "starting" } }, "look")).toBe(true);
    expect(showsConnect(null, "look")).toBe(true);
  });

  it("has no way back from the welcome or from an arrival under way", () => {
    expect(previousStep("welcome", false)).toBeNull();
    expect(previousStep("arrival", true)).toBeNull();
    expect(previousStep("name", false)).toBe("welcome");
  });
});
