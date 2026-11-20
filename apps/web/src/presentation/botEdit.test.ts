// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { bot } from "../test/fixtures";
import { botPatch, editsAfterFailedBotSave, modelChoices, noBotEdits } from "./botEdit";

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
        model: { ...claude },
        permissionMode: "supervised",
      }),
    ).toEqual({ _tag: "unchanged" });
    expect(botPatch(scout, { ...noBotEdits, name: "  ", title: "Research" })).toEqual({
      _tag: "invalid",
      fields: new Set(["name"]),
    });
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
    status: ready ? { _tag: "ready" as const } : { _tag: "unavailable" as const },
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
    );
    expect(choices.groups.map((group) => group.providerName)).toEqual(["claude", "codex"]);
    expect(choices.currentOffered).toBe(true);
    expect(choices.someNotReady).toBe(false);

    const elsewhere = modelChoices(
      engine([provider("claude", true, ["opus"]), provider("codex", false, ["gpt"])]),
      claude,
    );
    expect(elsewhere.groups.map((group) => group.providerName)).toEqual(["claude"]);
    expect(elsewhere.currentOffered).toBe(false);
    expect(elsewhere.someNotReady).toBe(true);
  });
});
