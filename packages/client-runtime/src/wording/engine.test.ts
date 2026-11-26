// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  harnessInstallFailures,
  ProviderId,
  type ProviderStatus,
} from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { engineProblem, harnessFailureText, providerLine, providerVersionLine } from "./engine.ts";

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
    expect(line(codex(current, { state: "updated" }))?.text).toBe(
      "The update finished: version 0.171.0",
    );
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

describe("an install that did not finish", () => {
  const en = createI18n("en");

  it("speaks of disk space only when the disk is full", () => {
    for (const reason of harnessInstallFailures) {
      expect(harnessFailureText(reason, en).includes("space"), reason).toBe(reason === "storage");
    }
    const engineFailed = (installFailure: "storage" | "in-use" | "download"): EngineStatus => ({
      state: { _tag: "unavailable", reason: "install-failed", installFailure },
      pinnedVersion: "0.1.12",
      providers: [],
    });
    expect(engineProblem(engineFailed("storage"), en)?.body).toContain("space");
    expect(engineProblem(engineFailed("in-use"), en)?.body).not.toContain("space");
    expect(engineProblem(engineFailed("download"), en)?.body).not.toContain("space");
  });
});

describe("a provider J3 Bots is installing", () => {
  const ctx = { i18n: createI18n("en"), now: DateTime.nowUnsafe(), timeZone: "UTC" } as const;

  it("says it is being installed, with how far, not that the engine found nothing", () => {
    const provider: ProviderStatus = {
      id: ProviderId.make("codex"),
      name: "Codex",
      harness: "codex",
      status: {
        _tag: "unavailable",
        checking: false,
        reason: "not-installed",
        detail: "Could not start Codex CLI (`codex`).",
      },
      models: [],
      usage: [],
      copy: {
        source: "none",
        version: null,
        latest: null,
        installable: true,
        task: { _tag: "downloading", receivedBytes: 42_900_000, totalBytes: 230_000_000 },
        last: null,
      },
    };
    expect(providerLine(provider, ctx, "this-computer")).toEqual({
      text: "Installing… 42 of 230 MB",
      tone: "waiting",
    });
  });
});
