// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { hasDefaultModel } from "./engine.ts";
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
    const connect = showsConnect(ready, false);
    expect(nextStep("look", connect)).toBe("arrival");
    expect(makingProgress("look", connect)).toEqual({ index: 1, count: 2 });
  });

  it("asks to connect a provider before the arrival while none can run the bot", () => {
    const connect = showsConnect(signedOut, false);
    expect(nextStep("look", connect)).toBe("connect");
    expect(nextStep("connect", connect)).toBe("arrival");
    expect(previousStep("connect", connect)).toBe("look");
  });

  it("keeps the connect step in the flow once shown, also after going back from it", () => {
    // A provider connected while the step was read, and the operator went back to the look.
    const connect = showsConnect(ready, true);
    expect(nextStep("connect", connect)).toBe("arrival");
    expect(nextStep("look", connect)).toBe("connect");
    expect(makingProgress("look", connect)).toEqual({ index: 1, count: 3 });
  });

  it("asks to connect while the engine is not running", () => {
    expect(showsConnect({ ...ready, state: { _tag: "starting" } }, false)).toBe(true);
    expect(showsConnect(null, false)).toBe(true);
  });

  it("has no way back from the welcome or from an arrival under way", () => {
    expect(previousStep("welcome", false)).toBeNull();
    expect(previousStep("arrival", true)).toBeNull();
    expect(previousStep("name", false)).toBe("welcome");
  });
});

describe("whether the server has a model for a first bot", () => {
  it("has one on a provider that is signed out or still being checked", () => {
    expect(hasDefaultModel(signedOut)).toBe(true);
    expect(hasDefaultModel(engine({ _tag: "unavailable", checking: true }))).toBe(true);
  });

  it("has none on a provider the engine checked and cannot run, though it lists models", () => {
    // As Claude Code not installed: the engine lists its catalog all the same.
    expect(hasDefaultModel(engine({ _tag: "unavailable", checking: false }))).toBe(false);
    expect(hasDefaultModel(null)).toBe(false);
  });
});
