// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EffortLevel,
  type EngineStatus,
  type ModelChoice,
  ModelId,
  ProviderId,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { bot } from "../../test/fixtures.ts";
import {
  botPatch,
  editsAfterFailedBotSave,
  effortChoices,
  pickUnavailable,
  noBotEdits,
  withHiddenEdit,
  withProfileEdit,
} from "./botEdit.ts";

const claude = { providerId: ProviderId.make("claude"), modelId: ModelId.make("sonnet") };
const codex = { providerId: ProviderId.make("codex"), modelId: ModelId.make("gpt") };
const scout = bot("Scout", { _tag: "idle" }, { model: claude });

describe("botPatch", () => {
  it("sends only the fields the operator changed", () => {
    expect(
      botPatch(scout, { ...noBotEdits, title: " Research ", model: codex, job: "" }, null),
    ).toEqual({
      _tag: "changes",
      changes: { profile: { title: "Research" }, model: codex },
    });
    // A name changed on another device is not written back.
    expect(
      botPatch(
        { ...scout, profile: { ...scout.profile, name: "Scout II" } },
        { ...noBotEdits, permissionMode: "auto" },
        null,
      ),
    ).toEqual({ _tag: "changes", changes: { permissionMode: "auto" } });
  });

  it("sends nothing for edits back to the saved values, and refuses an empty name", () => {
    expect(
      botPatch(
        scout,
        {
          name: "Scout ",
          title: "",
          job: null,
          avatar: { shape: "dome", color: "cobalt" },
          model: { ...claude },
          effort: null,
          fast: null,
          permissionMode: "supervised",
          hidden: null,
        },
        null,
      ),
    ).toEqual({ _tag: "unchanged" });
    expect(botPatch(scout, { ...noBotEdits, name: "  ", title: "Research" }, null)).toEqual({
      _tag: "invalid",
      fields: new Set(["name"]),
    });
  });

  it("refuses to empty a title the bot has, and saves a bot that never had one", () => {
    const titled = { ...scout, profile: { ...scout.profile, title: "Research" } };
    expect(botPatch(titled, { ...noBotEdits, title: "  " }, null)).toEqual({
      _tag: "invalid",
      fields: new Set(["title"]),
    });
    expect(botPatch(scout, { ...noBotEdits, title: "", permissionMode: "auto" }, null)).toEqual({
      _tag: "changes",
      changes: { permissionMode: "auto" },
    });
  });

  it("sends whether the bot is hidden whenever the operator moved the switch", () => {
    const hide = withHiddenEdit(noBotEdits, true, scout.hidden);
    expect(botPatch(scout, hide, null)).toEqual({ _tag: "changes", changes: { hidden: true } });
    // A bot hid it meanwhile: the operator's choice is still sent, so it is recorded as theirs.
    expect(botPatch({ ...scout, hidden: true }, hide, null)).toEqual({
      _tag: "changes",
      changes: { hidden: true },
    });
    // Moved back to what the bot is: nothing to send.
    expect(botPatch(scout, withHiddenEdit(hide, false, scout.hidden), null)).toEqual({
      _tag: "unchanged",
    });
  });

  it("sends a new avatar with the profile", () => {
    const avatar = { shape: "ghost", color: "honey" } as const;
    expect(botPatch(scout, { ...noBotEdits, avatar, title: "Research" }, null)).toEqual({
      _tag: "changes",
      changes: { profile: { title: "Research", avatar } },
    });
  });
});

describe("withProfileEdit", () => {
  it("drops a field typed back to where it started, so a later rename elsewhere stays", () => {
    const renamed = withProfileEdit(noBotEdits, "name", "Scout II", "Scout");
    const reverted = withProfileEdit(renamed, "name", "Scout", "Scout");
    const titled = withProfileEdit(reverted, "title", "Research", "");
    // Another device renames the bot before Save.
    const elsewhere = { ...scout, profile: { ...scout.profile, name: "Scout III" } };
    expect(botPatch(elsewhere, titled, null)).toEqual({
      _tag: "changes",
      changes: { profile: { title: "Research" } },
    });
    // Only an exact match ends the edit, so typing a space keeps it.
    expect(withProfileEdit(reverted, "name", "Scout ", "Scout").name).toBe("Scout ");
  });
});

describe("editsAfterFailedBotSave", () => {
  it("gives a form that did not see the save what it sent, and keeps what the form holds", () => {
    expect(
      editsAfterFailedBotSave(
        { ...noBotEdits, title: "Typed since" },
        { profile: { name: "Scout II", title: "Research" }, model: codex },
      ),
    ).toEqual({ ...noBotEdits, name: "Scout II", title: "Typed since", model: codex });
  });
});

describe("pickUnavailable", () => {
  const offering = (models: ReadonlyArray<ModelChoice>): EngineStatus => ({
    state: { _tag: "ready" },
    pinnedVersion: "1",
    providers: models.map((model) => ({
      id: model.providerId,
      name: model.providerId,
      harness: "other",
      status: { _tag: "ready" },
      models: [{ id: model.modelId, name: model.modelId }],
      usage: [],
    })),
  });

  it("holds the save for a pick the engine stopped offering, never for the bot's own", () => {
    expect(pickUnavailable(offering([claude]), claude, codex)).toBe(true);
    expect(pickUnavailable(offering([codex]), claude, claude)).toBe(false);
    expect(pickUnavailable(offering([codex]), claude, codex)).toBe(false);
    // Before the engine reports its models, the pick is left to the server.
    expect(pickUnavailable(null, claude, codex)).toBe(false);
  });
});

describe("effort", () => {
  const level = EffortLevel.make;
  const choice = (id: string, name: string) => ({ id: level(id), name });
  // Sonnet takes low, high and max; GPT takes low, medium and xhigh.
  const withEfforts: EngineStatus = {
    state: { _tag: "ready" },
    pinnedVersion: "1",
    providers: [
      {
        id: claude.providerId,
        name: "Claude",
        harness: "claude-code",
        status: { _tag: "ready" },
        models: [
          {
            id: claude.modelId,
            name: "Sonnet",
            efforts: [choice("low", "Low"), choice("high", "High"), choice("max", "Max")],
          },
        ],
        usage: [],
      },
      {
        id: codex.providerId,
        name: "Codex",
        harness: "codex",
        status: { _tag: "ready" },
        models: [
          {
            id: codex.modelId,
            name: "GPT",
            efforts: [
              choice("low", "Low"),
              choice("medium", "Medium"),
              choice("xhigh", "Extra High"),
            ],
          },
        ],
        usage: [],
      },
    ],
  };
  const atMax = { ...scout, effort: level("max") };

  it("sends a picked level, and the default as null", () => {
    expect(
      botPatch(scout, { ...noBotEdits, effort: { level: level("high") } }, withEfforts),
    ).toEqual({
      _tag: "changes",
      changes: { effort: "high" },
    });
    expect(botPatch(atMax, { ...noBotEdits, effort: { level: null } }, withEfforts)).toEqual({
      _tag: "changes",
      changes: { effort: null },
    });
    expect(
      botPatch(atMax, { ...noBotEdits, effort: { level: level("max") } }, withEfforts),
    ).toEqual({
      _tag: "unchanged",
    });
  });

  it("takes the default with a model that lacks the level, and keeps a level both take", () => {
    expect(botPatch(atMax, { ...noBotEdits, model: codex }, withEfforts)).toEqual({
      _tag: "changes",
      changes: { model: codex, effort: null },
    });
    expect(
      botPatch({ ...scout, effort: level("low") }, { ...noBotEdits, model: codex }, withEfforts),
    ).toEqual({
      _tag: "changes",
      changes: { model: codex },
    });
  });

  it("sends fast mode as the model the form holds runs it", () => {
    const fastClaude: EngineStatus = {
      ...withEfforts,
      providers: withEfforts.providers.map((provider) =>
        provider.id === claude.providerId
          ? { ...provider, models: provider.models.map((model) => ({ ...model, fast: true })) }
          : provider,
      ),
    };
    expect(botPatch(scout, { ...noBotEdits, fast: true }, fastClaude)).toEqual({
      _tag: "changes",
      changes: { fast: true },
    });
    // GPT has no fast mode: moving there turns it off in the same save.
    expect(botPatch({ ...scout, fast: true }, { ...noBotEdits, model: codex }, fastClaude)).toEqual(
      { _tag: "changes", changes: { model: codex, fast: false } },
    );
  });

  it("leaves a level the model stopped taking alone until the operator changes something", () => {
    const stopped = { ...scout, effort: level("ultra") };
    expect(botPatch(stopped, { ...noBotEdits, title: "Research" }, withEfforts)).toEqual({
      _tag: "changes",
      changes: { profile: { title: "Research" } },
    });
  });

  it("shows a level the model lacks as the default, and says which and why", () => {
    expect(effortChoices(withEfforts, codex, level("max"))).toEqual({
      levels: [choice("low", "Low"), choice("medium", "Medium"), choice("xhigh", "Extra High")],
      shown: null,
      fallback: { level: choice("max", "Max"), modelName: "GPT" },
    });
    expect(effortChoices(withEfforts, claude, level("max"))).toMatchObject({
      shown: "max",
      fallback: null,
    });
  });

  it("shows the level the form holds while the model's levels are not known", () => {
    expect(effortChoices(null, claude, level("high"))).toEqual({
      levels: [choice("high", "high")],
      shown: "high",
      fallback: null,
    });
    expect(effortChoices(null, claude, null).levels).toEqual([]);
  });
});
