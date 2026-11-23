// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot } from "../../test/fixtures.ts";
import { hasDefaultModel, openingHeld } from "./engine.ts";
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

describe("what holds a first bot's hello back", () => {
  const opening = bot(
    "Ana",
    { _tag: "idle" },
    {
      opening: true,
      model: { providerId: ProviderId.make("claude"), modelId: ModelId.make("m") },
    },
  );
  /** The engine with the bot's provider in `status`, and Codex signed out. */
  const withCodex = (status: ProviderStatus["status"]): EngineStatus => {
    const base = engine(status);
    const [claude] = base.providers;
    if (claude === undefined) return base;
    return {
      ...base,
      providers: [
        claude,
        {
          ...claude,
          id: ProviderId.make("codex"),
          name: "Codex",
          harness: "codex",
          status: { _tag: "sign-in-required", command: "j3-bots provider connect" },
        },
      ],
    };
  };

  it("waits for the usage limit to reset, when the provider is at it", () => {
    const resetsAt = at("2026-11-20T16:30:00Z");
    expect(openingHeld(opening, engine({ _tag: "limited", resetsAt }))).toEqual({
      _tag: "limit",
      resetsAt,
    });
  });

  it("offers connecting another provider when the bot's own cannot run at all", () => {
    expect(openingHeld(opening, withCodex({ _tag: "unavailable", checking: false }))).toEqual({
      _tag: "connect",
      command: "j3-bots provider connect",
    });
    // Still being checked, it may yet turn out ready.
    expect(openingHeld(opening, withCodex({ _tag: "unavailable", checking: true }))).toEqual({
      _tag: "provider",
    });
  });

  it("holds while the engine does not report the bot's provider, as the server does", () => {
    expect(openingHeld(opening, { ...ready, providers: [] })).toEqual({ _tag: "provider" });
    expect(openingHeld(opening, ready)).toBeNull();
  });
});
