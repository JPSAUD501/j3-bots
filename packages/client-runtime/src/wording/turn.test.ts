// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, EntryOrder, type BotState, type WorkFoldEntry } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, context, plain } from "../../test/fixtures.ts";
import { turnAnnouncement, turnLabel, turnLine } from "./turn.ts";

const started = "2026-11-20T14:00:00Z";
const ctxAt = (now: string) => context(now, "en", {});
const ctx = ctxAt("2026-11-20T14:01:00Z");

const working = (activity: string | null, stalled = false): BotState => ({
  _tag: "working",
  since: at(started),
  stalled,
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
  it("says what the bot is doing, as its header does, and only that it was working once out of touch", () => {
    expect(turnLine(bot("Scout", working("Running pnpm test")), false, ctx).text).toBe(
      "Running pnpm test",
    );
    expect(turnLine(bot("Scout", working(null)), false, ctx).text).toBe("Working");
    expect(turnLine(bot("Scout", working("Running pnpm test")), true, ctx)).toEqual({
      text: "Was working when the connection dropped",
      tone: "secondary",
    });
  });
});

describe("turnLabel", () => {
  it("reads the line with how long the turn has run", () => {
    const line = { text: "Thinking", tone: "default" } as const;
    expect(plain(turnLabel(line, 72_000, ctx))).toBe("Thinking, 1m 12s so far");
  });
});

describe("turnAnnouncement", () => {
  const said = (
    state: BotState,
    now = "2026-11-20T14:01:00Z",
    ended: WorkFoldEntry | null = null,
  ) => turnAnnouncement(bot("Scout", state), ended, ctxAt(now));

  it("says each new line while the bot works, and nothing more as its clock runs", () => {
    const first = said(working("Running pnpm test"));
    expect(said(working("Running pnpm test"), "2026-11-20T14:03:00Z")).toEqual(first);
    const next = said(working("Running pnpm lint"));
    expect(next.key).not.toBe(first.key);
    expect(next.text).toBe("Running pnpm lint");
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
    const finished = (ending: "completed" | "interrupted" | "failed") =>
      ({
        _tag: "finished",
        finishedAt: at("2026-11-20T14:01:12Z"),
        ending,
        waitedMs: 0,
        background: false,
      }) as const;
    expect(ending(finished("completed"))).toBe("Worked for 1m 12s");
    expect(ending(finished("interrupted"))).toBe("Stopped after 1m 12s");
    expect(ending(finished("failed"))).toBe("Failed after 1m 12s");
    expect(said({ _tag: "idle" }, undefined, fold(finished("completed"))).key).not.toBe(
      folding.key,
    );
  });

  it("says when the bot waits on the operator or is blocked", () => {
    const waiting = said({ _tag: "waiting", entryId: EntryId.make("card"), since: at(started) });
    expect(waiting.text).toBe("Waiting for you");
    const blocked = said({ _tag: "blocked", failure: "provider-error", retryAt: null });
    expect(blocked.key).not.toBe(waiting.key);
    expect(blocked.text).not.toBe("");
  });
});
