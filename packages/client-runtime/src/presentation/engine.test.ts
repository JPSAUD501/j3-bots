// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  type HarnessCopy,
  ModelId,
  ProviderId,
  type ProviderStatus,
  type UnavailableReason,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { ownHarness, preparation, providerDetail, providerFix, providerGate } from "./engine.ts";

const provider = (id: string, status: ProviderStatus["status"]): ProviderStatus => ({
  id: ProviderId.make(id),
  name: id,
  harness: "claude-code",
  status,
  models: [{ id: ModelId.make("m"), name: "Model" }],
  usage: [],
});

const engine = (...providers: ReadonlyArray<ProviderStatus>): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers,
});

const checking = { _tag: "unavailable", checking: true } as const;
const signedOut = { _tag: "sign-in-required", command: "j3-bots provider connect" } as const;

describe("providerGate", () => {
  it("waits for the engine's first check before saying a provider needs connecting", () => {
    expect(providerGate(engine(provider("claude", checking), provider("codex", checking)))).toEqual(
      { _tag: "checking" },
    );
    // The provider still being checked may turn out ready: connecting is not asked for yet.
    expect(
      providerGate(engine(provider("claude", checking), provider("codex", signedOut))),
    ).toEqual({ _tag: "checking" });
    expect(
      providerGate(
        engine(
          provider("claude", { _tag: "unavailable", checking: false }),
          provider("codex", signedOut),
        ),
      ),
    ).toEqual({ _tag: "connect", command: "j3-bots provider connect" });
  });

  it("lets the first bot be created once one provider can run it, while another is checked", () => {
    expect(
      providerGate(engine(provider("claude", { _tag: "ready" }), provider("codex", checking))),
    ).toEqual({ _tag: "ready" });
  });
});

describe("providerFix", () => {
  const unavailable = (reason?: UnavailableReason) =>
    ({ _tag: "unavailable", checking: false, ...(reason ? { reason } : {}) }) as const;

  it("installs a harness that is not there, from its maker's page, and retries one that failed", () => {
    expect(providerFix(provider("claude", unavailable("not-installed")))).toEqual({
      _tag: "install",
      page: "https://code.claude.com/docs/en/setup",
    });
    expect(
      providerFix({ ...provider("agent", unavailable("not-installed")), harness: "other" }),
    ).toEqual({ _tag: "install", page: null });
    expect(providerFix(provider("claude", unavailable("failed")))).toEqual({
      _tag: "retry",
      rechecking: false,
    });
    // Its check timed out, and the server already checks it again on its own.
    expect(
      providerFix(provider("claude", { ...unavailable("failed"), retryAt: DateTime.nowUnsafe() })),
    ).toEqual({ _tag: "retry", rechecking: true });
  });

  it("has the server install its own copy where it can, and follows that install", () => {
    const missing = (copy: HarnessCopy) => ({
      ...provider("claude", unavailable("not-installed")),
      copy,
    });
    const none: HarnessCopy = {
      source: "none",
      version: null,
      latest: "2.1.330",
      installable: true,
      task: null,
      last: null,
    };
    expect(providerFix(missing(none))).toEqual({
      _tag: "get",
      harness: "claude-code",
      failed: null,
    });
    expect(
      providerFix(
        missing({
          ...none,
          last: { _tag: "failed", reason: "checksum", at: DateTime.nowUnsafe() },
        }),
      ),
    ).toEqual({ _tag: "get", harness: "claude-code", failed: "checksum" });
    expect(providerFix(missing({ ...none, task: { _tag: "verifying" } }))).toEqual({
      _tag: "getting",
      harness: "claude-code",
      task: { _tag: "verifying" },
    });
    // No build for the server's machine: the maker's page, as on a server that installs none.
    expect(providerFix(missing({ ...none, installable: false }))).toEqual({
      _tag: "install",
      page: "https://code.claude.com/docs/en/setup",
    });
  });

  it("follows J3 Bots' own install while the engine still checks or says it found nothing", () => {
    const installing: HarnessCopy = {
      source: "none",
      version: null,
      latest: null,
      installable: true,
      task: { _tag: "downloading", receivedBytes: 42_000_000, totalBytes: 230_000_000 },
      last: null,
    };
    for (const status of [checking, unavailable("not-installed"), unavailable("failed")]) {
      expect(providerFix({ ...provider("claude", status), copy: installing })).toEqual({
        _tag: "getting",
        harness: "claude-code",
        task: installing.task,
      });
    }
    const failed: HarnessCopy = {
      ...installing,
      task: null,
      last: { _tag: "failed", reason: "in-use", at: DateTime.nowUnsafe() },
    };
    expect(providerFix({ ...provider("claude", checking), copy: failed })).toEqual({
      _tag: "get",
      harness: "claude-code",
      failed: "in-use",
    });
  });

  it("offers nothing where no client can fix it, or the server cannot check again", () => {
    for (const status of [
      unavailable("disabled"),
      unavailable("unknown"),
      unavailable(),
      checking,
      signedOut,
      { _tag: "ready" } as const,
    ]) {
      expect(providerFix(provider("claude", status))).toBeNull();
    }
  });
});

describe("ownHarness", () => {
  const copy: HarnessCopy = {
    source: "j3",
    version: "2.1.300",
    latest: "2.1.330",
    installable: true,
    task: null,
    last: null,
  };
  const ready = (own: HarnessCopy) => ({ ...provider("claude", { _tag: "ready" }), copy: own });

  it("offers a newer version only when the maker lists one", () => {
    expect(ownHarness(ready(copy))?.newer).toBe("2.1.330");
    expect(ownHarness(ready({ ...copy, latest: "2.1.300" }))?.newer).toBeNull();
    // A pre-release comes before its release.
    expect(
      ownHarness(ready({ ...copy, version: "2.1.330", latest: "2.1.330-beta.1" }))?.newer,
    ).toBeNull();
    expect(ownHarness(ready({ ...copy, latest: null }))?.newer).toBeNull();
  });

  it("is null for the operator's own harness, and on a server that installs none", () => {
    expect(ownHarness(ready({ ...copy, source: "operator", version: null }))).toBeNull();
    expect(ownHarness(provider("claude", { _tag: "ready" }))).toBeNull();
  });
});

describe("providerDetail", () => {
  const notFound = {
    _tag: "unavailable",
    checking: false,
    reason: "not-installed",
    detail: "Claude Agent CLI (`claude`) was not found on PATH.",
  } as const;
  const copy = (source: HarnessCopy["source"], installable: boolean): HarnessCopy => ({
    source,
    version: null,
    latest: null,
    installable,
    task: null,
    last: null,
  });

  it("leaves out the engine's words about a harness J3 Bots installs itself", () => {
    expect(
      providerDetail({ ...provider("claude", notFound), copy: copy("none", true) }),
    ).toBeNull();
  });

  it("keeps them where only the operator can act", () => {
    for (const status of [
      { ...provider("claude", notFound), copy: copy("operator", true) },
      { ...provider("claude", notFound), copy: copy("none", false) },
      provider("claude", notFound),
    ]) {
      expect(providerDetail(status)).toBe(notFound.detail);
    }
  });
});

describe("preparation", () => {
  const copy = (change: Partial<HarnessCopy>): HarnessCopy => ({
    source: "none",
    version: null,
    latest: null,
    installable: true,
    task: null,
    last: null,
    ...change,
  });

  it("follows the engine and both harnesses downloading at once, before the engine is ready", () => {
    const status: EngineStatus = {
      state: { _tag: "starting", install: { receivedBytes: 10, totalBytes: 100 } },
      pinnedVersion: "0.1.11",
      providers: [],
      harnesses: {
        "claude-code": copy({
          task: { _tag: "downloading", receivedBytes: 20, totalBytes: 200 },
        }),
        codex: copy({ task: { _tag: "verifying" } }),
      },
    };
    expect(preparation(status)).toEqual({
      items: [
        { id: "engine", state: "downloading", receivedBytes: 10, totalBytes: 100 },
        { id: "claude-code", state: "downloading", receivedBytes: 20, totalBytes: 200 },
        { id: "codex", state: "installing", receivedBytes: 0, totalBytes: null },
      ],
      ready: false,
    });
  });

  it("is ready once everything J3 Bots installs is, leaving out the operator's own", () => {
    const status: EngineStatus = {
      ...engine(),
      harnesses: {
        "claude-code": copy({ source: "j3", version: "2.1.326" }),
        codex: copy({ source: "operator" }),
      },
    };
    const ready = preparation(status);
    expect(ready.items.map((item) => item.id)).toEqual(["engine", "claude-code"]);
    expect(ready.ready).toBe(true);
    const failed = preparation({
      ...status,
      harnesses: {
        "claude-code": copy({
          last: { _tag: "failed", reason: "storage", at: DateTime.nowUnsafe() },
        }),
        codex: copy({ source: "operator" }),
      },
    });
    expect(failed.items[1]?.state).toBe("failed");
    expect(failed.ready).toBe(false);
  });
});
