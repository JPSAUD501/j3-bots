// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  type HarnessCopy,
  ModelId,
  ProviderId,
  type ProviderStatus,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { firstAccountOf, type SignInView } from "../stores/ProviderSetup.ts";
import {
  type AiAccount,
  aiAccountState,
  aiAccountStates,
  aiAction,
  type AiFacts,
  aiNameOf,
  aiOnItsWay,
  aiOutage,
  connectStepSaysProgress,
  queuedSignIn,
} from "./aiAccount.ts";

const provider = (
  account: AiAccount,
  status: ProviderStatus["status"],
  copy?: HarnessCopy,
): ProviderStatus => ({
  id: ProviderId.make(account),
  name: account,
  harness: account,
  status,
  models: [{ id: ModelId.make("model"), name: "Model", efforts: [] }],
  usage: [],
  ...(copy === undefined ? {} : { copy }),
});

const engineWith = (...providers: ReadonlyArray<ProviderStatus>): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers,
});

const first = firstAccountOf;

const facts = (
  engine: EngineStatus | null,
  signIns: ReadonlyArray<readonly [AiAccount, SignInView]> = [],
  found: ReadonlyArray<AiAccount> = [],
): AiFacts => ({
  engine,
  signIns: new Map(
    signIns.map(([account, view]) => [firstAccountOf(account).providerId, view] as const),
  ),
  locations: found.map((harness) => ({ harness, path: `/opt/${harness}` })),
});

const signedOut = { _tag: "sign-in-required", command: "j3-bots provider connect" } as const;
const notInstalled = { _tag: "unavailable", checking: false, reason: "not-installed" } as const;
const noCopy: HarnessCopy = {
  source: "none",
  version: null,
  latest: null,
  installable: true,
  task: null,
  last: null,
};

describe("where an AI account stands", () => {
  it("is the sign-in the operator is doing, whatever the engine still says of the provider", () => {
    const engine = engineWith(provider("claude-code", signedOut));
    expect(
      aiAccountState(first("claude-code"), facts(engine, [["claude-code", { _tag: "starting" }]])),
    ).toEqual({
      _tag: "signing-in",
      step: "opening",
      page: null,
    });
    const page = "https://example.com/oauth/authorize";
    const waiting = { _tag: "waiting-for-browser", url: page, opened: true } as const;
    expect(aiAccountState(first("claude-code"), facts(engine, [["claude-code", waiting]]))).toEqual({
      _tag: "signing-in",
      step: "browser",
      page,
    });
  });

  it("is finishing between a sign-in that succeeded and the engine's next check, then connected", () => {
    const done = [["codex", { _tag: "succeeded", endpoint: null }]] as const;
    expect(aiAccountState(first("codex"), facts(engineWith(provider("codex", signedOut)), done))).toEqual({
      _tag: "finishing",
    });
    expect(
      aiAccountState(first("codex"), facts(engineWith(provider("codex", { _tag: "ready" })), done)),
    ).toEqual({ _tag: "ready", limit: null });
  });

  it("offers a sign-in again to an account found signed out after its sign-in was spent", () => {
    const done = [["codex", { _tag: "succeeded", endpoint: null }]] as const;
    const signedOutAgain = {
      ...facts(engineWith(provider("codex", signedOut)), done),
      spent: new Set([first("codex").providerId]),
    };
    expect(aiAccountState(first("codex"), signedOutAgain)).toEqual({ _tag: "sign-in", failed: null });
  });

  it("keeps why the last sign-in ended on the signed-out account, so it can be tried again", () => {
    const failed = [["codex", { _tag: "failed", reason: "timed-out" }]] as const;
    expect(
      aiAccountState(first("codex"), facts(engineWith(provider("codex", signedOut)), failed)),
    ).toEqual({ _tag: "sign-in", failed: "timed-out" });
  });

  it("follows the download of what the account needs, and says why one did not finish", () => {
    const downloading = {
      ...noCopy,
      task: { _tag: "downloading", receivedBytes: 50, totalBytes: 200 },
    } as const;
    expect(
      aiAccountState(first("claude-code"),
        facts(engineWith(provider("claude-code", notInstalled, downloading))),
      ),
    ).toEqual({ _tag: "getting", task: "downloading", progress: 0.25 });
    expect(
      aiAccountState(first("claude-code"),
        facts(engineWith(provider("claude-code", notInstalled, noCopy))),
      ),
    ).toEqual({ _tag: "missing", canGet: true, failed: null, page: null });
    const failed: HarnessCopy = {
      ...noCopy,
      last: { _tag: "failed", reason: "unreachable", at: DateTime.makeUnsafe(0) },
    };
    expect(
      aiAccountState(first("claude-code"),
        facts(engineWith(provider("claude-code", notInstalled, failed))),
      ),
    ).toEqual({ _tag: "missing", canGet: true, failed: "unreachable", page: null });
    // A machine the server installs no build for: the maker's own page.
    expect(
      aiAccountState(first("codex"),
        facts(engineWith(provider("codex", notInstalled, { ...noCopy, installable: false }))),
      ),
    ).toEqual({
      _tag: "missing",
      canGet: false,
      failed: null,
      page: "https://developers.openai.com/codex/cli",
    });
  });

  it("follows J3 Bots' own install even while the engine still checks the provider", () => {
    const downloading: HarnessCopy = {
      ...noCopy,
      task: { _tag: "downloading", receivedBytes: 50, totalBytes: 200 },
    };
    const checking = { _tag: "unavailable", checking: true } as const;
    expect(
      aiAccountState(first("codex"), facts(engineWith(provider("codex", checking, downloading)))),
    ).toEqual({ _tag: "getting", task: "downloading", progress: 0.25 });
    expect(aiAccountState(first("codex"), facts(engineWith(provider("codex", checking))))).toEqual({
      _tag: "checking",
    });
  });

  it("stands where the server's copy does while J3 Bots starts and reports no provider yet", () => {
    const starting = (copy: HarnessCopy): EngineStatus => ({
      state: { _tag: "starting", install: { receivedBytes: 30, totalBytes: 120 } },
      pinnedVersion: "0.1.11",
      providers: [],
      harnesses: { "claude-code": copy, codex: noCopy },
    });
    const verifying: HarnessCopy = { ...noCopy, task: { _tag: "verifying" } };
    expect(aiAccountState(first("claude-code"), facts(starting(verifying)))).toEqual({
      _tag: "getting",
      task: "verifying",
      progress: null,
    });
    const held: HarnessCopy = {
      ...noCopy,
      last: { _tag: "failed", reason: "in-use", at: DateTime.makeUnsafe(0) },
    };
    expect(aiAccountState(first("claude-code"), facts(starting(held)))).toEqual({
      _tag: "missing",
      canGet: true,
      failed: "in-use",
      page: null,
    });
    // Its copy installed before the engine is up: the account can sign in already.
    const installed: HarnessCopy = { ...noCopy, source: "j3", version: "2.1.330" };
    expect(aiAccountState(first("claude-code"), facts(starting(installed)))).toEqual({
      _tag: "sign-in",
      failed: null,
    });
    // One the operator stopped waits for its button.
    expect(aiAccountState(first("codex"), facts(starting(installed)))).toEqual({
      _tag: "missing",
      canGet: true,
      failed: null,
      page: null,
    });
  });

  it("can sign in while J3 Bots still starts, once the server finds what the account needs", () => {
    const starting: EngineStatus = {
      state: { _tag: "starting", install: { receivedBytes: 30, totalBytes: 120 } },
      pinnedVersion: "0.1.11",
      providers: [],
    };
    expect(aiAccountState(first("codex"), facts(starting))).toEqual({ _tag: "preparing" });
    expect(aiAccountState(first("codex"), facts(starting, [], ["codex"]))).toEqual({
      _tag: "sign-in",
      failed: null,
    });
  });

  it("counts an account at its usage limit as connected", () => {
    const limited = engineWith(provider("claude-code", { _tag: "limited", resetsAt: null }));
    expect(aiAccountState(first("claude-code"), facts(limited))).toEqual({
      _tag: "ready",
      limit: { resetsAt: null },
    });
  });
});

describe("an account on its way, which the first run's Create follows", () => {
  it("is one connected, signing in, or just signed in, and not one that still asks for a press", () => {
    const engine = engineWith(
      provider("claude-code", signedOut),
      provider("codex", { _tag: "ready" }),
    );
    const states = aiAccountStates(facts(engine, [["claude-code", { _tag: "starting" }]]));
    expect(aiOnItsWay(states.codex, false)).toBe(true);
    expect(aiOnItsWay(states["claude-code"], false)).toBe(true);
    expect(aiOnItsWay({ _tag: "finishing" }, false)).toBe(true);
    expect(aiOnItsWay({ _tag: "sign-in", failed: null }, false)).toBe(false);
    expect(aiOnItsWay({ _tag: "getting", task: "downloading", progress: 0.4 }, false)).toBe(false);
  });

  it("is one whose sign-in, asked for early, waits for its download", () => {
    expect(aiOnItsWay({ _tag: "getting", task: "downloading", progress: 0.4 }, true)).toBe(true);
  });
});

describe("an account's one button", () => {
  const getting = { _tag: "getting", task: "downloading", progress: 0.4 } as const;
  const missing = { _tag: "missing", canGet: true, failed: null, page: null } as const;

  it("signs in from the app on the server's computer, and nowhere else", () => {
    const state = { _tag: "sign-in", failed: null } as const;
    expect(aiAction(state, "here")).toMatchObject({ _tag: "sign-in", queued: false });
    expect(aiAction(state, "desktop-app")).toBeNull();
    expect(aiAction(state, "server")).toBeNull();
  });

  it("takes the sign-in early while what the account needs is still to come", () => {
    expect(aiAction(getting, "here")).toMatchObject({ _tag: "sign-in", queued: true });
    expect(aiAction(missing, "here")).toMatchObject({ _tag: "sign-in", queued: true });
    expect(aiAction({ _tag: "checking" }, "here")).toMatchObject({ _tag: "sign-in", queued: true });
    // A client that signs nothing in has nothing to do while it downloads, and can start the download.
    expect(aiAction(getting, "server")).toBeNull();
    expect(aiAction(missing, "server")).toEqual({ _tag: "download", again: false });
  });

  it("tries a failed download again on its own, before any sign-in", () => {
    expect(aiAction({ ...missing, failed: "storage" }, "here")).toEqual({
      _tag: "download",
      again: true,
    });
  });

  it("checks again an account that did not start, and leaves alone one turned off", () => {
    expect(aiAction({ _tag: "problem", kind: "failed" }, "server")).toEqual({ _tag: "retry" });
    expect(aiAction({ _tag: "problem", kind: "off" }, "here")).toBeNull();
  });
});

describe("a sign-in asked for before it can start", () => {
  it("asks for the download nothing has started, waits through it and the check, then starts", () => {
    expect(queuedSignIn({ _tag: "preparing" })).toBe("keep");
    expect(queuedSignIn({ _tag: "missing", canGet: true, failed: null, page: null })).toBe(
      "download",
    );
    expect(queuedSignIn({ _tag: "getting", task: "verifying", progress: null })).toBe("keep");
    expect(queuedSignIn({ _tag: "checking" })).toBe("keep");
    expect(queuedSignIn({ _tag: "sign-in", failed: null })).toBe("start");
  });

  it("is dropped when the download fails or the account turns out connected", () => {
    expect(queuedSignIn({ _tag: "missing", canGet: true, failed: "checksum", page: null })).toBe(
      "drop",
    );
    expect(queuedSignIn({ _tag: "ready", limit: null })).toBe("drop");
    expect(queuedSignIn({ _tag: "problem", kind: "failed" })).toBe("drop");
  });
});

describe("what keeps J3 Bots from running any account", () => {
  it("is an engine that is out, not one still starting", () => {
    const base = engineWith();
    expect(aiOutage({ ...base, state: { _tag: "starting" } })).toBeNull();
    expect(aiOutage(null)).toBeNull();
    expect(aiOutage({ ...base, state: { _tag: "unavailable", reason: "down" } })).toEqual({
      _tag: "unavailable",
      reason: "down",
    });
  });
});

describe("the first run's quiet line, on the connect step", () => {
  it("says how far J3 Bots is while it only starts, and leaves an account's own download to its row", () => {
    const starting: EngineStatus = { ...engineWith(), state: { _tag: "starting" } };
    expect(connectStepSaysProgress(starting)).toBe(false);
    const downloading: EngineStatus = {
      ...starting,
      harnesses: {
        "claude-code": {
          ...noCopy,
          task: { _tag: "downloading", receivedBytes: 1, totalBytes: 4 },
        },
        codex: noCopy,
      },
    };
    expect(connectStepSaysProgress(downloading)).toBe(true);
    const out: EngineStatus = { ...engineWith(), state: { _tag: "unavailable", reason: "down" } };
    expect(connectStepSaysProgress(out)).toBe(true);
  });
});

describe("aiNameOf", () => {
  it("calls an AI by its account, any other provider by the engine's name, and none unlisted", () => {
    const other: ProviderStatus = {
      ...provider("codex", { _tag: "ready" }),
      id: ProviderId.make("local"),
      name: "Local model",
      harness: "other",
    };
    const engine = engineWith(provider("claude-code", { _tag: "ready" }), other);
    expect(aiNameOf(engine, ProviderId.make("claude-code"))).toBe("Claude");
    expect(aiNameOf(engine, ProviderId.make("local"))).toBe("Local model");
    expect(aiNameOf(engine, ProviderId.make("gone"))).toBeNull();
    expect(aiNameOf(null, ProviderId.make("claude-code"))).toBeNull();
  });
});
