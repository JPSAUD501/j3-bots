// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { engineProblem } from "./engine.ts";
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

  it("can be pressed while a provider may still run the bot, or before the engine is ready", () => {
    for (const status of [
      { _tag: "unavailable", checking: true } as const,
      { _tag: "sign-in-required", command: "j3-bots provider connect" } as const,
    ]) {
      expect(connectStepText(ready(claude(status)), "Nova", en).createWaits).toBeNull();
    }
    expect(connectStepText(null, "Nova", en).createWaits).toBeNull();
    expect(connectStepText(downloading(0, null), "Nova", en).createWaits).toBeNull();
  });
});
