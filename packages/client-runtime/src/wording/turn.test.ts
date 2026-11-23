// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, EntryOrder, type BotState, type WorkFoldEntry } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, context, plain } from "../../test/fixtures.ts";
import { nextSpoken, turnAnnouncement, turnLabel, turnLine, type Spoken } from "./turn.ts";

const started = "2026-11-20T14:00:00Z";
const ctxAt = (now: string) => context(now, "en", {});
const ctx = ctxAt("2026-11-20T14:01:00Z");

const working = (activity: string | null, stalled = false): BotState => ({
  _tag: "working",
  since: at(started),
  stalled,
  quietSince: stalled ? at(started) : null,
  activity,
  tool: null,
});

const fold = (status: WorkFoldEntry["status"]): WorkFoldEntry => ({
  _tag: "work-fold",
  id: EntryId.make("fold"),
  order: EntryOrder.make(1),
  author: { _tag: "system" },
  createdAt: at("2026-11-20T14:00:20Z"),
  turnStartedAt: at(started),
  stepCount: 2,
  status,
});

describe("turnLine", () => {
  it("says what the bot is doing, as its header does, and only as last known once out of touch", () => {
    expect(turnLine(bot("Scout", working("git status")), false, ctx).text).toBe("git status");
    expect(turnLine(bot("Scout", working(null)), false, ctx).text).toBe("Working");
    expect(turnLine(bot("Scout", working("git status")), true, ctx)).toEqual({
      text: "Last known: git status",
      tone: "secondary",
    });
  });
});

describe("turnLabel", () => {
  const line = { text: "Thinking", tone: "default" } as const;

  it("reads the line with how long the turn has run, in whole minutes", () => {
    expect(plain(turnLabel(line, 72_000, ctx))).toBe("Thinking, 1m so far");
    expect(turnLabel(line, 119_000, ctx)).toBe(turnLabel(line, 60_000, ctx));
  });

  it("reads only the line under a minute, and with no time to give", () => {
    expect(turnLabel(line, 59_000, ctx)).toBe("Thinking");
    expect(turnLabel(line, null, ctx)).toBe("Thinking");
  });
});

describe("turnAnnouncement", () => {
  const said = (
    state: BotState,
    now = "2026-11-20T14:01:00Z",
    ended: WorkFoldEntry | null = null,
    offline = false,
  ) => turnAnnouncement(bot("Scout", state), ended, offline, ctxAt(now));
  const finished = (ending: "completed" | "interrupted" | "failed") =>
    ({
      _tag: "finished",
      finishedAt: at("2026-11-20T14:01:12Z"),
      ending,
      waitedMs: 0,
      waitedBeforeMs: 0,
      background: false,
    }) as const;
  const waiting: BotState = { _tag: "waiting", entryId: EntryId.make("card"), since: null };
  const blocked: BotState = { _tag: "blocked", failure: "usage-limit", retryAt: null };

  it("says each new line while the bot works, and nothing more as its clock runs", () => {
    const first = said(working("git status"));
    expect(said(working("git status"), "2026-11-20T14:03:00Z")).toEqual(first);
    const next = said(working("git diff"));
    expect(next.key).not.toBe(first.key);
    expect(next.text).toBe("git diff");
  });

  it("says once that a turn has gone quiet, not again each minute of quiet", () => {
    const quiet = said(working(null, true), "2026-11-20T14:06:00Z");
    expect(quiet.text).toMatch(/No activity/);
    expect(said(working(null, true), "2026-11-20T14:09:00Z").key).toBe(quiet.key);
    expect(quiet.key).not.toBe(said(working(null)).key);
  });

  it("says how the turn ended once its fold has, and nothing while it is still folding", () => {
    const folding = said({ _tag: "idle" }, undefined, fold({ _tag: "running" }));
    expect(folding.text).toBe("");
    const ending = (status: WorkFoldEntry["status"]) =>
      plain(said({ _tag: "idle" }, undefined, fold(status)).text);
    expect(ending(finished("completed"))).toBe("Worked for 1m 12s");
    expect(ending(finished("interrupted"))).toBe("Stopped after 1m 12s");
    expect(ending(finished("failed"))).toBe("Failed after 1m 12s");
    const ended = said({ _tag: "idle" }, undefined, fold(finished("completed")));
    expect(ended.key).not.toBe(folding.key);
    expect(ended.ending).toBe(true);
  });

  it("goes on saying each state after a turn's fold: a question it asked, a usage limit", () => {
    const ended = fold(finished("completed"));
    const asks = said(waiting, undefined, ended);
    expect(asks).toEqual({ key: "waiting", text: "Waiting for you", ending: false });
    const limited = said(blocked, undefined, ended);
    expect(limited.key).toBe("blocked");
    expect(limited.text).not.toBe("");
  });

  it("says once that what it shows is the last it knew, and the state again once back", () => {
    const dropped = said(working("git status"), undefined, null, true);
    expect(dropped.text).toBe("Last known: git status");
    // Nothing more is said while out of touch, however the clock runs.
    expect(said(working("git status"), "2026-11-20T14:05:00Z", null, true)).toEqual(dropped);
    const back = said(working("git status"));
    expect(back.key).not.toBe(dropped.key);
    expect(back.text).toBe("git status");
    // A bot with no turn under way has nothing to say out of touch.
    expect(said({ _tag: "idle" }, undefined, null, true).key).toBe("idle");
  });

  it("says when the bot waits on the operator or is blocked", () => {
    const holds = said({ _tag: "waiting", entryId: EntryId.make("card"), since: at(started) });
    expect(holds.text).toBe("Waiting for you");
    const cannot = said({ _tag: "blocked", failure: "provider-error", retryAt: null });
    expect(cannot.key).not.toBe(holds.key);
    expect(cannot.text).not.toBe("");
  });
});

describe("nextSpoken", () => {
  const ended = { key: "ended-fold", text: "Worked for 1m 12s", ending: true };
  const asks = { key: "waiting", text: "Waiting for you", ending: false };
  const run = (opened: string | null, ...said: ReadonlyArray<Parameters<typeof nextSpoken>[1]>) => {
    let spoken: Spoken = { key: opened, ending: null };
    const out: Array<string> = [];
    for (const next of said) {
      const step = nextSpoken(spoken, next);
      spoken = step.spoken;
      if (step.say !== null) out.push(step.say);
    }
    return out;
  };

  it("says nothing of what was current as the conversation opened", () => {
    expect(run("waiting", asks)).toEqual([]);
  });

  it("says an ending once, though the bot idles on it again after a question", () => {
    expect(run("working:git status", ended, asks, ended)).toEqual([
      "Worked for 1m 12s",
      "Waiting for you",
    ]);
  });

  it("says nothing for a key with no text, as a fold still finishing", () => {
    expect(
      run("working:git status", { key: "ending-fold", text: "", ending: false }, ended),
    ).toEqual(["Worked for 1m 12s"]);
  });
});
