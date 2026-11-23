// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, EntryOrder, type WorkFoldEntry } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, message } from "../../test/fixtures.ts";
import { buildTimeline, type TimelineItem } from "./timeline.ts";
import { liveTurn, turnClock, turnElapsed, withLiveTurn } from "./turn.ts";

const started = "2026-11-20T14:00:00Z";
const scout = bot("Scout", { _tag: "thinking", since: at(started), stalled: false });
const asScout = { _tag: "bot", botId: scout.id } as const;

const fold = (
  status: WorkFoldEntry["status"],
  turnStartedAt: string | null = started,
  createdAt = "2026-11-20T14:00:20Z",
): WorkFoldEntry => ({
  _tag: "work-fold",
  id: EntryId.make(`fold-${createdAt}`),
  order: EntryOrder.make(50),
  author: asScout,
  createdAt: at(createdAt),
  turnStartedAt: turnStartedAt === null ? null : at(turnStartedAt),
  stepCount: 2,
  status,
});

const finished = (createdAt?: string) =>
  fold(
    {
      _tag: "finished",
      finishedAt: at("2026-11-20T14:01:12Z"),
      ending: "completed",
      waitedMs: 0,
      background: false,
    },
    started,
    createdAt,
  );

const asked = message("2026-11-20T13:59:58Z", { _tag: "operator" }, "Run the tests");
const turnOf = (state: Parameters<typeof bot>[1]) => liveTurn(bot("Scout", state));
const work = (rows: ReadonlyArray<TimelineItem>) =>
  rows.flatMap((row) => (row.kind === "work" ? [row] : []));

describe("liveTurn", () => {
  it("is under way while the bot thinks, works, or waits within a turn", () => {
    expect(liveTurn(scout)?.startedAt).toEqual(at(started));
    const working = turnOf({
      _tag: "working",
      since: at(started),
      stalled: true,
      activity: null,
      tool: null,
    });
    expect(working?.startedAt).toEqual(at(started));
    const waiting = turnOf({ _tag: "waiting", entryId: EntryId.make("card"), since: at(started) });
    expect(waiting?.startedAt).toEqual(at(started));
  });

  it("is over while the bot waits between turns, is blocked, or idles", () => {
    expect(turnOf({ _tag: "waiting", entryId: EntryId.make("card"), since: null })).toBeNull();
    expect(turnOf({ _tag: "blocked", failure: "provider-error", retryAt: null })).toBeNull();
    expect(turnOf({ _tag: "idle" })).toBeNull();
  });
});

describe("withLiveTurn", () => {
  it("puts a turn with no work yet at the end, where the reply will appear", () => {
    const rows = withLiveTurn(buildTimeline([asked]), liveTurn(scout));
    expect(rows.at(-1)).toMatchObject({ kind: "work", fold: null, live: true });
  });

  it("keeps one row, under one key, from the turn's start through its fold to its end", () => {
    const turn = liveTurn(scout);
    const before = withLiveTurn(buildTimeline([asked]), turn);
    const working = withLiveTurn(buildTimeline([asked, fold({ _tag: "running" })]), turn);
    const ended = withLiveTurn(buildTimeline([asked, finished()]), null);
    const keys = [before, working, ended].map((rows) => work(rows).map((row) => row.key));
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
    expect(work(working)[0]?.live).toBe(true);
    expect(work(ended)[0]?.live).toBe(false);
  });

  it("shows the turn in its fold's place, with what the bot said after it below", () => {
    const said = message("2026-11-20T14:00:40Z", asScout, "On it");
    const rows = withLiveTurn(
      buildTimeline([asked, fold({ _tag: "running" }), said]),
      liveTurn(scout),
    );
    expect(rows.map((row) => row.kind)).toEqual(["divider", "message", "work", "message"]);
    expect(work(rows)).toEqual([expect.objectContaining({ live: true })]);
  });

  it("lets the bot's reply take the place of a turn that did no work", () => {
    const reply = message("2026-11-20T14:00:30Z", asScout, "All green");
    const rows = withLiveTurn(buildTimeline([asked, reply]), liveTurn(scout));
    expect(work(rows)).toEqual([]);
    // A reply from before the turn does not.
    const earlier = message("2026-11-20T13:50:00Z", asScout, "Earlier");
    expect(work(withLiveTurn(buildTimeline([earlier, asked]), liveTurn(scout)))).toHaveLength(1);
  });

  it("never takes another turn's fold for this one", () => {
    const old = fold({ _tag: "running" }, "2026-11-20T13:00:00Z", "2026-11-20T13:00:05Z");
    const rows = withLiveTurn(buildTimeline([old, asked]), liveTurn(scout));
    expect(work(rows).map((row) => row.live)).toEqual([false, true]);
  });

  it("takes a fold from a server that predates turnStartedAt by when it was written", () => {
    const ours = fold({ _tag: "running" }, null, "2026-11-20T14:00:20Z");
    const rows = withLiveTurn(buildTimeline([asked, ours]), liveTurn(scout));
    expect(work(rows)).toEqual([expect.objectContaining({ fold: ours, live: true })]);
  });
});

describe("the turn's clock", () => {
  it("counts from the turn's start on the server, never below none", () => {
    const turn = { botId: scout.id, startedAt: at(started) };
    expect(turnElapsed(turn, Date.parse("2026-11-20T14:01:12Z"))).toBe(72_000);
    expect(turnElapsed(turn, Date.parse("2026-11-20T13:59:58Z"))).toBe(0);
  });

  it("reads m:ss, then h:mm:ss past an hour", () => {
    expect(turnClock(7_400)).toBe("0:07");
    expect(turnClock(72_000)).toBe("1:12");
    expect(turnClock(12 * 60_000 + 40_000)).toBe("12:40");
    expect(turnClock(3_723_000)).toBe("1:02:03");
  });
});
