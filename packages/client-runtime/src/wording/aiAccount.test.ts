// SPDX-License-Identifier: AGPL-3.0-or-later
import { type EngineStatus, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { AiAccountState, AiPlace } from "../presentation/aiAccount.ts";
import {
  type AiAccountContext,
  aiAccountText,
  aiActionLabel,
  connectStepText,
} from "./aiAccount.ts";

const en = createI18n("en");
const ctx = { i18n: en, timeZone: "UTC", now: DateTime.makeUnsafe("2026-11-20T14:00:00Z") };

const claude = (status: ProviderStatus["status"]): ProviderStatus => ({
  id: ProviderId.make("claude-code"),
  name: "Claude Code",
  harness: "claude-code",
  status,
  // Claude Code lists its catalog whatever its state.
  models: [{ id: ModelId.make("claude-haiku-5-5"), name: "Haiku 5.5", efforts: [] }],
  usage: [],
});

const ready = (...providers: ReadonlyArray<ProviderStatus>): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.12",
  providers,
});

const at = (place: AiPlace, engine: EngineStatus | null = null): AiAccountContext => ({
  engine,
  place,
  signIn: undefined,
  queued: false,
});

const signedOut: AiAccountState = { _tag: "sign-in", failed: null };

/** The words an operator must never meet outside "Details". */
const jargon = /harness|\bCLI\b|engine|PATH|binary/i;

describe("an AI account, in words", () => {
  it("gives the command that signs that account in only where a command is the way", () => {
    expect(aiAccountText("claude-code", signedOut, at("server"), ctx).command).toBe(
      "j3-bots provider login claude-code",
    );
    expect(aiAccountText("codex", signedOut, at("server"), ctx).command).toBe(
      "j3-bots provider login codex --device-auth",
    );
    const inApp = aiAccountText("codex", signedOut, at("desktop-app"), ctx);
    expect(inApp.command).toBeNull();
    expect(inApp.hint).toContain("Open J3 Bots on your computer");
    expect(aiAccountText("codex", signedOut, at("here"), ctx)).toMatchObject({
      command: null,
      hint: null,
    });
  });

  it("keeps the engine's own words for the details, out of what the operator reads first", () => {
    const said =
      "Claude Agent CLI is installed but failed to run. Timed out while running command.";
    const engine = ready(
      claude({ _tag: "unavailable", checking: false, reason: "failed", detail: said }),
    );
    const text = aiAccountText(
      "claude-code",
      { _tag: "problem", kind: "failed" },
      at("here", engine),
      ctx,
    );
    expect(text.line).toBe("Claude is there, but it didn’t start.");
    expect(`${text.line} ${text.hint}`).not.toMatch(jargon);
    expect(text.details[0]).toBe(said);
  });

  it("says a failed sign-in plainly, with what repairs it under the details", () => {
    const text = aiAccountText(
      "codex",
      { _tag: "sign-in", failed: "needs-terminal" },
      at("here"),
      ctx,
    );
    expect(text).toMatchObject({
      line: "ChatGPT couldn’t open its sign-in page from this app.",
      tone: "blocked",
    });
    expect(text.details).toEqual([
      "Codex can only sign in from a terminal on this computer, which the app doesn’t have. Use an endpoint instead.",
    ]);
  });

  it("says how far a download is, and that the browser opens after it once sign-in was asked for", () => {
    const getting: AiAccountState = { _tag: "getting", task: "downloading", progress: 0.42 };
    expect(aiAccountText("claude-code", getting, at("here"), ctx)).toMatchObject({
      line: "Downloading Claude… 42%",
      hint: null,
    });
    expect(aiAccountText("claude-code", getting, { ...at("here"), queued: true }, ctx).hint).toBe(
      "Your browser opens as soon as this is done.",
    );
  });

  it("names its button for what it does next", () => {
    const signIn = { _tag: "sign-in", queued: false, download: false, again: false } as const;
    expect(aiActionLabel(signIn, "codex", en)).toBe("Sign in with ChatGPT");
    expect(aiActionLabel({ ...signIn, again: true }, "codex", en)).toBe("Try again");
    expect(aiActionLabel({ _tag: "look" }, "codex", en)).toBe("Look again");
  });
});

describe("the connect step", () => {
  it("asks which AI the operator has while none is open, in both languages", () => {
    const step = connectStepText(
      ready(claude({ _tag: "unavailable", checking: true })),
      null,
      null,
      "Nova",
      en,
    );
    expect(step.title).toBe("Which AI will Nova use?");
    expect(connectStepText(null, null, null, "Nova", createI18n("pt-BR")).title).toBe(
      "Qual IA Nova vai usar?",
    );
  });

  it("lets the bot be created while its AI still downloads, and says it greets once connected", () => {
    const engine = ready(claude({ _tag: "unavailable", checking: false, reason: "not-installed" }));
    const step = connectStepText(engine, null, null, "Nova", en);
    expect(step.createWaits).toBeNull();
    expect(step.later).toBe(
      "No rush: create Nova now, and it says hello as soon as its AI is connected.",
    );
  });

  it("holds Create only while the server has no model to give the bot, and says why in plain words", () => {
    const starting: EngineStatus = {
      state: { _tag: "starting", install: { receivedBytes: 0, totalBytes: null } },
      pinnedVersion: "0.1.12",
      providers: [],
    };
    const step = connectStepText(starting, null, null, "Nova", en);
    expect(step.createWaits).toBe(
      "J3 Bots is still getting ready. You can create Nova in a moment.",
    );
    expect(step.later).toBeNull();
    // Before the server answers at all, the client waits for it to create the bot.
    expect(connectStepText(null, null, null, "Nova", en).createWaits).toBeNull();
  });

  it("says the account is connected, and drops the line about later", () => {
    const state: AiAccountState = { _tag: "ready", limit: null };
    const engine = ready(claude({ _tag: "ready" }));
    const text = aiAccountText("claude-code", state, at("here", engine), ctx);
    const step = connectStepText(engine, { account: "claude-code", text }, state, "Nova", en);
    expect(step).toMatchObject({
      title: "Claude is connected",
      body: "Everything is ready for Nova to say hello.",
      later: null,
      createWaits: null,
    });
  });

  it("says in plain words that J3 Bots itself is out, with its own account of it kept for the details", () => {
    const out = (reason: "down" | "port-in-use"): EngineStatus => ({
      ...ready(),
      state: { _tag: "unavailable", reason },
    });
    const restarting = connectStepText(out("down"), null, null, "Nova", en);
    expect(restarting.title).toBe("J3 Bots is restarting");
    const stuck = connectStepText(out("port-in-use"), null, null, "Nova", en);
    expect(stuck.title).toBe("J3 Bots can’t run your bots right now");
    for (const step of [restarting, stuck]) {
      expect(`${step.title} ${step.body}`).not.toMatch(jargon);
    }
    expect(stuck.details[0]).toBe("The engine’s port is taken");
    // The server lists no AI while its engine is out, so the bot waits for it to run again.
    const silent = connectStepText(
      { ...out("port-in-use"), providers: [] },
      null,
      null,
      "Nova",
      en,
    );
    expect(silent.createWaits).toBe("You can create Nova once J3 Bots is running again.");
  });

  it("says a download that failed its checksum as one that came out damaged, in both languages", () => {
    const state: AiAccountState = { _tag: "missing", canGet: true, failed: "checksum", page: null };
    const text = aiAccountText("claude-code", state, at("server"), ctx);
    expect(text.line).toBe("The download came out damaged, so nothing was installed. Try again.");
    expect(text.details).toContain(
      "The download didn’t match its maker’s checksum, so nothing was installed.",
    );
    const pt = { ...ctx, i18n: createI18n("pt-BR") };
    expect(aiAccountText("claude-code", state, at("server"), pt).line).toBe(
      "O download veio corrompido, então nada foi instalado. Tente de novo.",
    );
  });

  it("gives the server's own sentence for a failure it already says plainly, with nothing doubled under Details", () => {
    const state: AiAccountState = {
      _tag: "missing",
      canGet: true,
      failed: "unreachable",
      page: null,
    };
    const text = aiAccountText("claude-code", state, at("server"), ctx);
    expect(text.line).toBe(
      "Couldn’t download it. Check that the server is online, then try again.",
    );
    expect(text.details).toEqual(["Claude Code, download: unreachable"]);
  });

  it("says what the operator can do when J3 Bots' own install failed on a full disk or a held file, and keeps the rest for the details", () => {
    const failed = (installFailure: "storage" | "in-use" | "permission"): EngineStatus => ({
      state: { _tag: "unavailable", reason: "install-failed", installFailure },
      pinnedVersion: "0.1.12",
      providers: [],
    });
    const full = connectStepText(failed("storage"), null, null, "Nova", en);
    expect(full.title).toBe("J3 Bots couldn’t finish getting ready");
    expect(full.body).toContain("Free up some space");
    const held = connectStepText(failed("in-use"), null, null, "Nova", en);
    const refused = connectStepText(failed("permission"), null, null, "Nova", en);
    expect(refused.body).toBe("It keeps trying on its own. Details says what went wrong.");
    for (const step of [full, held, refused]) {
      expect(`${step.title} ${step.body}`).not.toMatch(jargon);
      expect(step.details).toHaveLength(2);
    }
  });

  it("leaves the engine's “not found” out of the details of an account J3 Bots is installing itself", () => {
    const state: AiAccountState = { _tag: "missing", canGet: true, failed: "in-use", page: null };
    const engine = ready({
      ...claude({
        _tag: "unavailable",
        checking: false,
        reason: "not-installed",
        detail: "Claude Agent CLI (`claude`) is not installed.",
      }),
      copy: {
        source: "none",
        version: null,
        latest: null,
        installable: true,
        task: null,
        last: { _tag: "failed", reason: "in-use", at: DateTime.makeUnsafe(0) },
      },
    });
    const text = aiAccountText("claude-code", state, at("here", engine), ctx);
    expect(text.line).toBe(
      "Another program, such as an antivirus, was using its files. Try again in a moment.",
    );
    expect(text.details).toEqual(["Claude Code, download: in-use"]);
  });

  it("says a first download J3 Bots could not switch to of the account, not of a copy before it", () => {
    const state: AiAccountState = { _tag: "missing", canGet: true, failed: "engine", page: null };
    const text = aiAccountText("claude-code", state, at("here"), ctx);
    expect(text.line).toBe("Claude was downloaded, but J3 Bots couldn’t start using it yet.");
    expect(text.line).not.toMatch(jargon);
    expect(text.details).toContain(
      "The engine couldn’t switch to it, so the copy before keeps running.",
    );
  });
});
