// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EffortLevel,
  type EngineStatus,
  ModelId,
  ProviderId,
  type ProviderStatus,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { botAccountState, modelPicker, searchModels, withModel, withStar } from "./modelPicker.ts";

const level = EffortLevel.make;
const work = ProviderId.make("claude-code_work");
const opus = { providerId: ProviderId.make("claude-code"), modelId: ModelId.make("opus") };
const sonnet = { providerId: work, modelId: ModelId.make("sonnet") };
const gpt = { providerId: ProviderId.make("codex"), modelId: ModelId.make("gpt-5") };

const setup = (enabled: boolean) => ({
  enabled,
  added: false,
  binaryPath: null,
  launchArguments: "",
  home: "/srv/j3/providers/x",
});

const account = (
  id: ProviderStatus["id"],
  name: string,
  harness: ProviderStatus["harness"],
  status: ProviderStatus["status"],
  models: ProviderStatus["models"],
  enabled = true,
): ProviderStatus => ({ id, name, harness, status, models, usage: [], setup: setup(enabled) });

const engine: EngineStatus = {
  state: { _tag: "ready" },
  pinnedVersion: "1",
  providers: [
    account(opus.providerId, "Claude Code", "claude-code", { _tag: "ready" }, [
      {
        id: opus.modelId,
        name: "Claude Opus",
        fast: true,
        efforts: [
          { id: level("low"), name: "Low" },
          { id: level("max"), name: "Max" },
        ],
      },
    ]),
    account(work, "Claude (work)", "claude-code", { _tag: "sign-in-required", command: "x" }, [
      { id: sonnet.modelId, name: "Claude Sonnet" },
    ]),
    account(
      gpt.providerId,
      "Codex",
      "codex",
      { _tag: "unavailable", checking: false, reason: "disabled" },
      [{ id: gpt.modelId, name: "GPT-5", efforts: [{ id: level("low"), name: "Low" }] }],
      false,
    ),
  ],
};

describe("modelPicker", () => {
  it("lists every account, and lets a bot onto those that run", () => {
    const picker = modelPicker(engine, []);
    expect(picker.accounts.map(({ name, state, choosable }) => [name, state, choosable])).toEqual([
      ["Claude Code", "ready", true],
      ["Claude (work)", "signed-out", false],
      ["Codex", "off", false],
    ]);
  });

  it("lists the starred models first, in the order they were starred, and keeps a star it cannot list", () => {
    const gone = { providerId: ProviderId.make("gone"), modelId: ModelId.make("old") };
    const picker = modelPicker(engine, [gpt, gone, opus]);
    expect(picker.starred.map((model) => model.name)).toEqual(["GPT-5", "Claude Opus"]);
    expect(withStar([gpt, gone, opus], gpt, false)).toEqual([gone, opus]);
    expect(withStar([gone], sonnet, true)).toEqual([gone, sonnet]);
  });

  it("finds a model by any words of its name or account, case and accents aside", () => {
    const picker = modelPicker(engine, []);
    expect(searchModels(picker, "  claude WORK ").map((model) => model.name)).toEqual([
      "Claude Sonnet",
    ]);
    expect(searchModels(picker, "ópus").map((model) => model.name)).toEqual(["Claude Opus"]);
    expect(searchModels(picker, "")).toHaveLength(3);
  });
});

describe("withModel", () => {
  it("keeps the effort and fast mode the new model takes, and drops what it lacks", () => {
    const onOpus = { model: opus, effort: level("low"), fast: true };
    expect(withModel(engine, onOpus, gpt)).toEqual({ model: gpt, effort: "low", fast: false });
    expect(withModel(engine, { ...onOpus, effort: level("max") }, gpt)).toEqual({
      model: gpt,
      effort: null,
      fast: false,
    });
  });
});

describe("botAccountState", () => {
  it("says a bot's account was removed or turned off, only where the server can say", () => {
    expect(botAccountState(engine, sonnet)).toBe("ok");
    expect(botAccountState(engine, gpt)).toBe("off");
    const removed = { providerId: ProviderId.make("claude-code_gone"), modelId: opus.modelId };
    expect(botAccountState(engine, removed)).toBe("gone");
    // An engine that is not running lists nothing, which says nothing of removal.
    expect(botAccountState({ ...engine, state: { _tag: "starting" } }, removed)).toBe("ok");
    const older = {
      ...engine,
      providers: engine.providers.map(({ setup: _setup, ...provider }) => provider),
    };
    expect(botAccountState(older, removed)).toBe("ok");
  });
});
