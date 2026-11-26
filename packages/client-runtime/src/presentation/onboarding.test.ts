// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  LANGUAGES,
  ModelId,
  ProviderId,
  type ProviderStatus,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot } from "../../test/fixtures.ts";
import { hasDefaultModel, openingHeld } from "./engine.ts";
import {
  acrossStage,
  defaultBotName,
  nextStep,
  type OnboardingStep,
  gettingReady,
  readyingShare,
  previousStep,
  resumedStep,
  showsConnect,
  stageCast,
  stageLight,
  stageScene,
  stepProgress,
  workExamples,
  workTurn,
} from "./onboarding.ts";

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
  const flow = (connect: boolean) => ({ connect });

  it("goes from the look straight to the arrival when a provider can run the bot", () => {
    const steps = flow(showsConnect(ready, false));
    expect(nextStep("look", steps)).toBe("arrival");
    expect(stepProgress("look", steps)).toEqual({ index: 4, count: 5 });
  });

  it("says what J3 Bots is before it asks anything", () => {
    const steps = flow(false);
    const walked: Array<OnboardingStep> = [];
    for (let at: OnboardingStep | null = "welcome"; at !== null; at = nextStep(at, steps)) {
      walked.push(at);
    }
    expect(walked).toEqual(["welcome", "work", "mind", "name", "look", "arrival"]);
    // Back from the first thing asked returns into the story, and the story has a way back too.
    expect(previousStep("name", steps)).toBe("mind");
    expect(previousStep("work", steps)).toBe("welcome");
  });

  it("asks to connect a provider before the arrival while none can run the bot", () => {
    const steps = flow(showsConnect(signedOut, false));
    expect(nextStep("look", steps)).toBe("connect");
    expect(nextStep("connect", steps)).toBe("arrival");
    expect(previousStep("connect", steps)).toBe("look");
  });

  it("keeps the connect step in the flow once shown, also after going back from it", () => {
    // A provider connected while the step was read, and the operator went back to the look.
    const steps = flow(showsConnect(ready, true));
    expect(nextStep("connect", steps)).toBe("arrival");
    expect(nextStep("look", steps)).toBe("connect");
    expect(stepProgress("look", steps)).toEqual({ index: 4, count: 6 });
  });

  it("asks to connect while the engine is not running", () => {
    expect(showsConnect({ ...ready, state: { _tag: "starting" } }, false)).toBe(true);
    expect(showsConnect(null, false)).toBe(true);
  });

  it("has no way back from the welcome or from an arrival under way", () => {
    expect(previousStep("welcome", flow(false))).toBeNull();
    expect(previousStep("arrival", flow(true))).toBeNull();
  });

  it("gives the arrival no dot: it is not a step the operator takes", () => {
    expect(stepProgress("arrival", flow(true))).toBeNull();
  });
});

describe("a first run picked up again", () => {
  it("starts from the step it was left at, while the flow still has it", () => {
    expect(resumedStep("name", { connect: false })).toBe("name");
    expect(resumedStep("work", { connect: false })).toBe("work");
    expect(resumedStep("connect", { connect: true })).toBe("connect");
  });

  it("goes back to the look from a step the flow no longer has, and from the arrival", () => {
    expect(resumedStep("connect", { connect: false })).toBe("look");
    expect(resumedStep("arrival", { connect: true })).toBe("look");
  });
});

describe("the cast's turns in the light", () => {
  it("gives each bot across the stage one example, and the last to everyone", () => {
    const turns = workExamples.map((_, turn) => workTurn(turn));
    expect(turns.map((turn) => turn.example)).toEqual(workExamples);
    expect(turns.slice(0, -1).map((turn) => turn.featured)).toEqual(acrossStage);
    expect(turns.at(-1)?.featured).toBe("all");
    // From one side to the other, so the light travels instead of jumping about.
    const places = acrossStage.map((place) => stageCast[place]?.x ?? Number.NaN);
    expect(places).toEqual([...places].sort((a, b) => a - b));
  });

  it("goes round again after the last", () => {
    expect(workTurn(workExamples.length)).toEqual(workTurn(0));
  });
});

describe("how each bot on the stage is lit", () => {
  const lights = (step: OnboardingStep, featured: number | "all" = "all") =>
    stageCast.map((_, place) => stageLight(stageScene(step, false), place, featured));

  it("lights everyone on the welcome, the lead most", () => {
    expect(lights("welcome")).toEqual(["key", "fill", "fill", "fill", "fill"]);
  });

  it("lights only the bot whose turn it is, and everyone on the turn they share", () => {
    expect(lights("work", 3)).toEqual(["spill", "spill", "spill", "key", "spill"]);
    expect(lights("work", "all")).toEqual(["key", "key", "key", "key", "key"]);
  });

  it("puts the whole cast under one light while it thinks", () => {
    expect(new Set(lights("mind"))).toEqual(new Set(["shared"]));
  });

  it("leaves only the bot being made lit while it is made", () => {
    expect(lights("name")).toEqual(["key", "spill", "spill", "spill", "spill"]);
  });
});

describe("what the server is getting ready", () => {
  const copy = {
    source: "none",
    version: null,
    latest: "2.1.330",
    installable: true,
    task: null,
    last: null,
  } as const;
  /** The engine ready, with each provider's harness copy as given. */
  const withCopies = (
    ...copies: ReadonlyArray<NonNullable<ProviderStatus["copy"]>>
  ): EngineStatus => {
    const [claude] = ready.providers;
    if (claude === undefined) return ready;
    return {
      ...ready,
      providers: copies.map((each, index) => ({
        ...claude,
        id: ProviderId.make(`provider-${index}`),
        copy: each,
      })),
    };
  };

  it("says nothing before the server reports, unless the device knows it is starting", () => {
    expect(gettingReady(null, false)).toEqual({ _tag: "idle" });
    expect(gettingReady(null, true)).toEqual({ _tag: "preparing", fraction: null });
  });

  it("follows the engine's download, and shows no share while its size is unknown", () => {
    const downloading = (totalBytes: number | null): EngineStatus => ({
      ...ready,
      state: { _tag: "starting", install: { receivedBytes: 45, totalBytes } },
    });
    expect(readyingShare(gettingReady(downloading(180), false))).toBe(0.25);
    expect(readyingShare(gettingReady(downloading(null), false))).toBeNull();
    expect(gettingReady({ ...ready, state: { _tag: "starting" } }, false)._tag).toBe("preparing");
  });

  it("puts the harnesses on their way together into one share", () => {
    const engine = withCopies(
      { ...copy, task: { _tag: "downloading", receivedBytes: 50, totalBytes: 100 } },
      { ...copy, task: { _tag: "verifying" } },
    );
    expect(readyingShare(gettingReady(engine, false))).toBe(0.75);
  });

  it("never shows the whole while something is still under way", () => {
    const engine = withCopies({ ...copy, task: { _tag: "verifying" } });
    expect(gettingReady(engine, false)._tag).toBe("preparing");
    expect(readyingShare(gettingReady(engine, false))).toBe(0.99);
  });

  it("is ready once the engine runs and nothing it installs is missing", () => {
    expect(gettingReady(ready, false)).toEqual({ _tag: "ready" });
    const own = withCopies({ ...copy, source: "j3", version: "2.1.330" });
    expect(gettingReady(own, false)).toEqual({ _tag: "ready" });
  });

  it("does not wait for an update that waits for the bots, nor call it getting ready", () => {
    const waiting = withCopies({
      ...copy,
      source: "j3",
      version: "2.1.300",
      task: { _tag: "waiting" },
    });
    expect(gettingReady(waiting, false)).toEqual({ _tag: "ready" });
  });

  it("claims neither while a harness is missing with no install under way, or the engine is out", () => {
    // As an install that failed: the connect step says so; this line must not say "ready".
    expect(gettingReady(withCopies(copy), false)).toEqual({ _tag: "idle" });
    const out: EngineStatus = {
      ...ready,
      state: { _tag: "unavailable", reason: "install-failed" },
    };
    expect(gettingReady(out, false)).toEqual({ _tag: "idle" });
  });
});

describe("the stage's set", () => {
  it("closes in on the bot being made, and opens on everyone once it exists", () => {
    expect(stageScene("welcome", false)).toMatchObject({ camera: "wide", cast: "lit" });
    expect(stageScene("name", false)).toMatchObject({ camera: "close", cast: "dim", named: true });
    expect(stageScene("arrival", false)).toMatchObject({ camera: "close", cast: "dim" });
    expect(stageScene("arrival", true)).toMatchObject({ camera: "finale", cast: "lit" });
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

describe("the first bot's default name", () => {
  const seeds = Array.from({ length: 8 }, (_, seed) => seed);

  it("comes from the operator's language, varying with the seed", () => {
    for (const language of LANGUAGES) {
      const names = new Set(seeds.map((seed) => defaultBotName(language, seed)));
      expect(names.size).toBe(seeds.length);
    }
    const english = new Set(seeds.map((seed) => defaultBotName("en", seed)));
    expect(seeds.filter((seed) => english.has(defaultBotName("pt-BR", seed)))).toEqual([]);
  });
});
