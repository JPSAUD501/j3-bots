// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CredentialFill,
  EntryId,
  EntryOrder,
  SiteOrigin,
  type WorkFoldEntry,
  type WorkStep,
  WorkStepId,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../../test/fixtures.ts";
import { fillDetail, stepText, workDoneText, workFoldTitle } from "./work.ts";

const ctx = context("2026-11-20T15:00:00Z", "en", {});

const fold = (status: WorkFoldEntry["status"]): WorkFoldEntry => ({
  _tag: "work-fold",
  id: EntryId.make("fold"),
  order: EntryOrder.make(1),
  author: { _tag: "system" },
  createdAt: at("2026-11-20T14:00:00Z"),
  turnStartedAt: null,
  status,
  stepCount: 3,
  apps: [],
});

const finished = (
  finishedAt: string,
  waitedMs: number,
  background = false,
  ending: "completed" | "interrupted" | "failed" = "completed",
  waitedBeforeMs = 0,
) =>
  fold({
    _tag: "finished",
    finishedAt: at(finishedAt),
    ending,
    waitedMs,
    waitedBeforeMs,
    background,
  });

describe("workFoldTitle", () => {
  it("gives no duration while the turn runs, nor while the work it handed off still runs", () => {
    expect(workFoldTitle(fold({ _tag: "running" }), ctx)).toBe("Working");
    const handedOff = workFoldTitle(finished("2026-11-20T14:05:00Z", 0, true), ctx);
    expect(handedOff).not.toMatch(/\d/);
  });

  it("keeps a failed or stopped turn's ending and time while the work it handed off runs", () => {
    for (const ending of ["failed", "interrupted"] as const) {
      const ended = plain(workFoldTitle(finished("2026-11-20T14:03:00Z", 0, false, ending), ctx));
      const running = plain(workFoldTitle(finished("2026-11-20T14:03:00Z", 0, true, ending), ctx));
      expect(running.startsWith(ended)).toBe(true);
      expect(running).not.toBe(ended);
    }
  });

  it("counts the turn's time less what it spent waiting on the operator", () => {
    expect(plain(workFoldTitle(finished("2026-11-20T14:05:00Z", 0), ctx))).toBe("Worked for 5m");
    expect(plain(workFoldTitle(finished("2026-11-20T14:05:00Z", 3 * 60_000), ctx))).toBe(
      "Worked for 2m",
    );
  });

  it("counts from the turn's start, as the turn's clock did, when the server says it", () => {
    const fromTurn: WorkFoldEntry = {
      ...finished("2026-11-20T14:01:12Z", 0),
      // The first step came 20 s into the turn; the clock had counted from its start.
      createdAt: at("2026-11-20T14:00:20Z"),
      turnStartedAt: at("2026-11-20T14:00:00Z"),
    };
    expect(plain(workFoldTitle(fromTurn, ctx))).toBe("Worked for 1m 12s");
    const ptBR = context("2026-11-20T15:00:00Z", "pt-BR", {});
    expect(plain(workFoldTitle(fromTurn, ptBR))).toBe("Trabalhou por 1 min 12 s");
  });

  it("leaves out a wait before the fold was written only when it counts from the turn's start", () => {
    // Two minutes on an approval before the first step, one after.
    const waited = finished("2026-11-20T14:05:00Z", 60_000, false, "completed", 2 * 60_000);
    expect(plain(workFoldTitle(waited, ctx))).toBe("Worked for 4m");
    const fromTurn = { ...waited, turnStartedAt: at("2026-11-20T13:58:00Z") };
    expect(plain(workFoldTitle(fromTurn, ctx))).toBe("Worked for 4m");
  });

  it("says how a turn stopped or failed before its first step ended, and when", () => {
    const before = (finishedAt: string, ending: "interrupted" | "failed"): WorkFoldEntry => ({
      ...finished(finishedAt, 0, false, ending),
      createdAt: at(finishedAt),
      turnStartedAt: at("2026-11-20T14:00:00Z"),
      stepCount: 0,
      apps: [],
    });
    expect(plain(workFoldTitle(before("2026-11-20T14:01:04Z", "interrupted"), ctx))).toBe(
      "Stopped after 1m 4s",
    );
    expect(plain(workFoldTitle(before("2026-11-20T14:00:12Z", "failed"), ctx))).toBe(
      "Failed after 12s",
    );
  });

  it("says how every turn ended", () => {
    const ended = (ending: "completed" | "interrupted" | "failed") =>
      plain(workFoldTitle(finished("2026-11-20T14:01:12Z", 0, false, ending), ctx));
    expect(ended("completed")).toBe("Worked for 1m 12s");
    expect(ended("interrupted")).toBe("Stopped after 1m 12s");
    expect(ended("failed")).toBe("Failed after 1m 12s");
  });
});

describe("workDoneText", () => {
  it("says a turn stopped or failed before its first step did only that", () => {
    expect(workDoneText(null, "interrupted", ctx.i18n)).toBe("Stopped");
    expect(workDoneText(null, "failed", ctx.i18n)).toBe("Failed");
    expect(workDoneText(null, null, ctx.i18n)).toBe("Did some work");
    const ran = { kind: "command", tool: null, label: "git status" } as const;
    expect(plain(workDoneText(ran, "interrupted", ctx.i18n))).toBe("Ran git status");
  });
});

describe("a login's fill", () => {
  const step = (fill: CredentialFill): WorkStep => ({
    id: WorkStepId.make("step"),
    kind: "tool",
    tool: "login",
    label: "Filled a saved login",
    status: fill.outcome._tag === "filled" ? "completed" : "failed",
    startedAt: at("2026-11-20T14:00:00Z"),
    finishedAt: at("2026-11-20T14:00:01Z"),
    fill,
  });
  const fill = (outcome: CredentialFill["outcome"], origin: string | null): CredentialFill => ({
    name: "github-work",
    secretId: null,
    field: "password",
    origin: origin === null ? null : SiteOrigin.make(origin),
    outcome,
  });

  it("names the login and the field, and whether it was filled", () => {
    const done = fill({ _tag: "filled", submitted: true }, "https://github.com");
    expect(stepText(step(done), ctx.i18n)).toBe("Filled the password of github-work");
    expect(fillDetail(done, ctx.i18n)).toBe("On https://github.com, then sent the form.");
    const refused = fill({ _tag: "refused", reason: "no-tab" }, "https://github.com");
    expect(stepText(step(refused), ctx.i18n)).toBe("Didn’t fill the password of github-work");
  });

  it("shows the page a refused fill was asked on, as the server checked it", () => {
    const lookalike = fill({ _tag: "refused", reason: "origin" }, "https://xn--gthub-zsa.com");
    expect(fillDetail(lookalike, ctx.i18n)).toBe(
      "The page, https://xn--gthub-zsa.com, isn’t one of the login’s sites.",
    );
    expect(fillDetail(fill({ _tag: "refused", reason: "origin" }, null), ctx.i18n)).toBe(
      "The page isn’t one of the login’s sites.",
    );
  });
});
