// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { engineProblem, providerVersionLine } from "./engine.ts";
import { connectStepText } from "./onboarding.ts";

const downloading = (receivedBytes: number, totalBytes: number | null): EngineStatus => ({
  state: { _tag: "starting", install: { receivedBytes, totalBytes } },
  pinnedVersion: "0.1.12",
  providers: [],
});

describe("the engine's first download", () => {
  const en = createI18n("en");

  it("says how far it has come, in whole megabytes of the size", () => {
    expect(engineProblem(downloading(42_900_000, 180_200_000), en)?.title).toBe(
      "Downloading the engine… 42 of 180 MB",
    );
    expect(engineProblem(downloading(42_900_000, 180_200_000), createI18n("pt-BR"))?.title).toBe(
      "Baixando o motor… 42 de 180 MB",
    );
  });

  it("says what it has when the size is not known", () => {
    expect(engineProblem(downloading(42_900_000, null), en)?.title).toBe(
      "Downloading the engine… 42 MB",
    );
  });

  it("is the connect step's live line, under the starting title, and goes once installed", () => {
    const during = connectStepText(downloading(42_900_000, 180_200_000), "Nova", en);
    expect(during.title).toBe("The engine is starting");
    expect(during.status).toEqual({
      text: "Downloading the engine… 42 of 180 MB",
      tone: "waiting",
    });
    const after = connectStepText(
      { ...downloading(0, null), state: { _tag: "starting" } },
      "Nova",
      en,
    );
    expect(after.status).toEqual({ text: "Starting…", tone: "waiting" });
  });
});

describe("the connect step's Create", () => {
  const en = createI18n("en");
  const claude = (status: ProviderStatus["status"]): ProviderStatus => ({
    id: ProviderId.make("claude-code"),
    name: "Claude Code",
    harness: "claude-code",
    status,
    // Claude Code lists its catalog whatever its state.
    models: [{ id: ModelId.make("claude-haiku-5-5"), name: "Haiku 5.5" }],
    usage: [],
  });
  const ready = (provider: ProviderStatus): EngineStatus => ({
    state: { _tag: "ready" },
    pinnedVersion: "0.1.12",
    providers: [provider],
  });

  it("waits, and says why, while the server has no model to give the bot", () => {
    const step = connectStepText(
      ready(claude({ _tag: "unavailable", checking: false, reason: "not-installed" })),
      "Nova",
      en,
    );
    expect(step.createWaits).toBe("You can create Nova as soon as Claude Code or Codex can run.");
    expect(step.later).toBeNull();
  });

  it("waits while the engine starts, since the server knows no provider yet", () => {
    expect(connectStepText(downloading(0, null), "Nova", en).createWaits).toBe(
      "You can create Nova as soon as Claude Code or Codex can run.",
    );
  });

  it("can be pressed while a provider may still run the bot, or before the server answers", () => {
    for (const status of [
      { _tag: "unavailable", checking: true } as const,
      { _tag: "sign-in-required", command: "j3-bots provider connect" } as const,
    ]) {
      expect(connectStepText(ready(claude(status)), "Nova", en).createWaits).toBeNull();
    }
    expect(connectStepText(null, "Nova", en).createWaits).toBeNull();
  });
});

describe("a provider's version and update", () => {
  const en = createI18n("en");
  const codex = (
    version: ProviderStatus["version"],
    update?: ProviderStatus["update"],
  ): ProviderStatus => ({
    id: ProviderId.make("codex"),
    name: "Codex",
    harness: "codex",
    status: { _tag: "ready" },
    models: [],
    usage: [],
    ...(version === undefined ? {} : { version }),
    ...(update === undefined ? {} : { update }),
  });
  const behind = { installed: "0.170.0", latest: "0.171.0" };
  const current = { installed: "0.171.0", latest: null, canUpdate: false };
  const line = (provider: ProviderStatus) => providerVersionLine(provider, en);

  it("offers Update for a newer version only when the engine can install it", () => {
    expect(line(codex({ ...behind, canUpdate: true }))).toEqual({
      text: "Version 0.170.0. 0.171.0 is out.",
      detail: null,
      offer: true,
    });
    expect(line(codex({ ...behind, canUpdate: false }))).toEqual({
      text: "Version 0.170.0. 0.171.0 is out.",
      detail: "Update it the way you installed it.",
      offer: false,
    });
    expect(line(codex(current))?.text).toBe("Version 0.171.0");
    // No version from the server: nothing to say.
    expect(line(codex(undefined))).toBeNull();
  });

  it("follows the update the operator asked for", () => {
    expect(line(codex({ ...behind, canUpdate: true }, { state: "running" }))).toEqual({
      text: "Updating…",
      detail: null,
      offer: false,
    });
    // A failed update can be asked again, and says what the engine said.
    expect(
      line(codex({ ...behind, canUpdate: true }, { state: "failed", detail: "npm exited 1" })),
    ).toEqual({
      text: "The update didn’t finish",
      detail: "The engine says: npm exited 1",
      offer: true,
    });
    expect(line(codex(current, { state: "updated" }))?.text).toBe("Up to date: version 0.171.0");
    // The command ran, but the engine's check did not confirm a newer version.
    expect(
      line(
        codex({ ...behind, canUpdate: true }, { state: "unverified", detail: "Still 0.170.0." }),
      ),
    ).toEqual({
      text: "The update ran, but the engine couldn’t confirm a newer version",
      detail: "The engine says: Still 0.170.0.",
      offer: true,
    });
    // An update that left a harness the engine no longer finds still says how it went.
    expect(line(codex(undefined, { state: "failed" }))).toEqual({
      text: "The update didn’t finish",
      detail: null,
      offer: false,
    });
  });
});
