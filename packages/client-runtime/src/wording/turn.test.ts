// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, EntryOrder, type BotState, type WorkFoldEntry } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, context, plain } from "../../test/fixtures.ts";
import { nextSpoken, turnAnnouncement, turnLine, type Spoken } from "./turn.ts";

const started = "2026-11-20T14:00:00Z";
const ctxAt = (now: string) => context(now, "en", {});
const ctx = ctxAt("2026-11-20T14:01:00Z");

/** A bot on a step: a command by default, as the label the engine gave it. */
const working = (
  activity: string | null,
  stalled = false,
  activityKind: "command" | "read" = "command",
): BotState => ({
  _tag: "working",
  since: at(started),
  stalled,
  typing: false,
  retrying: false,
  activity,
  activityKind: activity === null ? null : activityKind,
  tool: null,
  littleOnes: 0,
});

const fold = (status: WorkFoldEntry["status"]): WorkFoldEntry => ({
  _tag: "work-fold",
  id: EntryId.make("fold"),
  order: EntryOrder.make(1),
  author: { _tag: "system" },
  createdAt: at("2026-11-20T14:00:20Z"),
  turnStartedAt: at(started),
  stepCount: 2,
  apps: [],
  work: null,
  status,
});

describe("turnLine", () => {
  it("says what the bot is doing in plain words, and only as last known once out of touch", () => {
    const powershell = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command Get-ChildItem`;
    expect(turnLine(bot("Scout", working(powershell)), false, ctx).text).toBe("Running a command");
    expect(turnLine(bot("Scout", working("src/app.ts", false, "read")), false, ctx).text).toBe(
      "Reading a file",
    );
    expect(turnLine(bot("Scout", working(null)), false, ctx).text).toBe("Working");
    expect(turnLine(bot("Scout", working("git status")), true, ctx)).toEqual({
      text: "Last known: Running a command",
      tone: "secondary",
    });
  });

  it("says a stall it last knew of as last known", () => {
    expect(turnLine(bot("Scout", working("git status", true)), true, ctx).text).toBe(
      "Last known: No activity for a while",
    );
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
    }) as const;
  const waiting: BotState = { _tag: "waiting", entryId: EntryId.make("card"), since: null };
  const blocked: BotState = { _tag: "blocked", failure: "usage-limit", retryAt: null };

  it("says each new line while the bot works, and nothing more as time passes", () => {
    const first = said(working("git status"));
    expect(said(working("git status"), "2026-11-20T14:03:00Z")).toEqual(first);
    // Another command reads the same: nothing new to say.
    expect(said(working("git diff")).key).toBe(first.key);
    const next = said(working("src/app.ts", false, "read"));
    expect(next.key).not.toBe(first.key);
    expect(next.text).toBe("Reading a file");
  });

  it("says once that a turn has gone quiet, not again each minute of quiet", () => {
    const quiet = said(working(null, true), "2026-11-20T14:06:00Z");
    expect(quiet.text).toBe("No activity for a while");
    expect(said(working(null, true), "2026-11-20T14:09:00Z").key).toBe(quiet.key);
    expect(quiet.key).not.toBe(said(working(null)).key);
  });

  it("says how the turn ended once its fold has, and nothing while it is still folding", () => {
    const folding = said({ _tag: "idle" }, undefined, fold({ _tag: "running" }));
    expect(folding.text).toBe("");
    const ending = (status: WorkFoldEntry["status"]) =>
      plain(said({ _tag: "idle" }, undefined, fold(status)).text);
    expect(ending(finished("completed"))).toBe("Worked");
    expect(ending(finished("interrupted"))).toBe("Stopped");
    expect(ending(finished("failed"))).toBe("Failed");
    const ended = said({ _tag: "idle" }, undefined, fold(finished("completed")));
    expect(ended.key).not.toBe(folding.key);
    expect(ended.ending).toBe(true);
  });

  it("says how the turn ended only once the little ones it handed off are home", () => {
    const out = (working: number): WorkFoldEntry => ({
      ...fold(finished("completed")),
      work: { plan: null, littleOnes: { ones: [], working, total: 2 } },
    });
    const away = said({ _tag: "idle", littleOnes: 2 }, undefined, out(2));
    expect(away.text).toBe("");
    const home = said({ _tag: "idle" }, undefined, out(0));
    expect(plain(home.text)).toBe("Worked");
    expect(home.key).not.toBe(away.key);
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
    expect(dropped.text).toBe("Last known: Running a command");
    // Nothing more is said while out of touch, however long it lasts.
    expect(said(working("git status"), "2026-11-20T14:05:00Z", null, true)).toEqual(dropped);
    const back = said(working("git status"));
    expect(back.key).not.toBe(dropped.key);
    expect(back.text).toBe("Running a command");
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
  const ended = { key: "ended-fold", text: "Worked", ending: true };
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
    expect(run("working:git status", ended, asks, ended)).toEqual(["Worked", "Waiting for you"]);
  });

  it("says nothing for a key with no text, as a fold still finishing", () => {
    expect(
      run("working:git status", { key: "ending-fold", text: "", ending: false }, ended),
    ).toEqual(["Worked"]);
  });
});
