// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { bot } from "../../test/fixtures.ts";
import {
  botPatch,
  editsAfterFailedBotSave,
  modelChoices,
  noBotEdits,
  withHiddenEdit,
  withProfileEdit,
} from "./botEdit.ts";

const claude = { providerId: ProviderId.make("claude"), modelId: ModelId.make("sonnet") };
const codex = { providerId: ProviderId.make("codex"), modelId: ModelId.make("gpt") };
const scout = bot("Scout", { _tag: "idle" }, { model: claude });

describe("botPatch", () => {
  it("sends only the fields the operator changed", () => {
    expect(botPatch(scout, { ...noBotEdits, title: " Research ", model: codex, job: "" })).toEqual({
      _tag: "changes",
      changes: { profile: { title: "Research" }, model: codex },
    });
    // A name changed on another device is not written back.
    expect(
      botPatch(
        { ...scout, profile: { ...scout.profile, name: "Scout II" } },
        { ...noBotEdits, permissionMode: "auto" },
      ),
    ).toEqual({ _tag: "changes", changes: { permissionMode: "auto" } });
  });

  it("sends nothing for edits back to the saved values, and refuses an empty name", () => {
    expect(
      botPatch(scout, {
        name: "Scout ",
        title: "",
        job: null,
        avatar: { shape: "dome", color: "cobalt" },
        model: { ...claude },
        permissionMode: "supervised",
        hidden: null,
      }),
    ).toEqual({ _tag: "unchanged" });
    expect(botPatch(scout, { ...noBotEdits, name: "  ", title: "Research" })).toEqual({
      _tag: "invalid",
      fields: new Set(["name"]),
    });
  });

  it("sends whether the bot is hidden whenever the operator moved the switch", () => {
    const hide = withHiddenEdit(noBotEdits, true, scout.hidden);
    expect(botPatch(scout, hide)).toEqual({ _tag: "changes", changes: { hidden: true } });
    // A bot hid it meanwhile: the operator's choice is still sent, so it is recorded as theirs.
    expect(botPatch({ ...scout, hidden: true }, hide)).toEqual({
      _tag: "changes",
      changes: { hidden: true },
    });
    // Moved back to what the bot is: nothing to send.
    expect(botPatch(scout, withHiddenEdit(hide, false, scout.hidden))).toEqual({
      _tag: "unchanged",
    });
  });

  it("sends a new avatar with the profile", () => {
    const avatar = { shape: "ghost", color: "honey" } as const;
    expect(botPatch(scout, { ...noBotEdits, avatar, title: "Research" })).toEqual({
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
    expect(botPatch(elsewhere, titled)).toEqual({
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

describe("modelChoices", () => {
  const provider = (id: string, ready: boolean, models: ReadonlyArray<string>) => ({
    id: ProviderId.make(id),
    name: id,
    harness: "other" as const,
    status: ready ? { _tag: "ready" as const } : { _tag: "unavailable" as const, checking: false },
    models: models.map((model) => ({ id: ModelId.make(model), name: model })),
    usage: [],
  });
  const engine = (providers: EngineStatus["providers"]): EngineStatus => ({
    state: { _tag: "ready" },
    pinnedVersion: "1",
    providers,
  });

  it("offers the ready providers and the bot's own, and says when one is left out", () => {
    const choices = modelChoices(
      engine([provider("claude", false, ["sonnet"]), provider("codex", true, ["gpt"])]),
      claude,
      null,
    );
    expect(choices.groups.map((group) => group.providerName)).toEqual(["claude", "codex"]);
    expect(choices.unoffered).toEqual([]);
    expect(choices.someNotReady).toBe(false);

    const elsewhere = modelChoices(
      engine([provider("claude", true, ["opus"]), provider("codex", false, ["gpt"])]),
      claude,
      null,
    );
    expect(elsewhere.groups.map((group) => group.providerName)).toEqual(["claude"]);
    expect(elsewhere.unoffered).toEqual([claude]);
    expect(elsewhere.someNotReady).toBe(true);
  });

  it("keeps a pick the engine stopped offering in the list, and holds the save for another", () => {
    const gone = modelChoices(
      engine([provider("claude", true, ["sonnet"]), provider("codex", false, ["gpt"])]),
      claude,
      codex,
    );
    expect(gone.unoffered).toEqual([codex]);
    expect(gone.pickUnavailable).toBe(true);

    // Moving back to the bot's own model, or to one still offered, is fine.
    expect(modelChoices(engine([provider("codex", true, ["gpt"])]), claude, claude)).toMatchObject({
      unoffered: [claude],
      pickUnavailable: false,
    });
    expect(
      modelChoices(engine([provider("codex", true, ["gpt"])]), claude, codex).pickUnavailable,
    ).toBe(false);
    // Before the engine reports its models, the pick is listed and left to the server.
    expect(modelChoices(null, claude, codex)).toMatchObject({
      unoffered: [claude, codex],
      pickUnavailable: false,
    });
  });
});
