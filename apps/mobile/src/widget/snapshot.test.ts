// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Loaded } from "@j3-bots/client-runtime";
import {
  type BotState,
  BotId,
  EntryId,
  ModelId,
  ProviderId,
  type Routine,
  RoutineId,
  type RoutineRun,
  RoutineRunId,
  type RosterItem,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { AppLink } from "../links.ts";
import {
  RESULT_LENGTH,
  resultStart,
  snapshotKey,
  WORKING_HOLDS,
  type WidgetFacts,
  type WidgetWords,
  widgetSnapshot,
} from "./snapshot.ts";

const ada = BotId.make("ada");
const digest = RoutineId.make("digest");
const said = EntryId.make("said");

const bot = (state: BotState = { _tag: "idle" }): RosterItem => ({
  _tag: "bot",
  bot: {
    id: ada,
    profile: { name: "Ada", title: "", avatar: { shape: "dome", color: "cobalt" }, job: "" },
    model: { providerId: ProviderId.make("claude"), modelId: ModelId.make("opus") },
    effort: null,
    permissionMode: "auto",
    primary: false,
    pinned: false,
    hidden: false,
    sectionId: null,
    state,
    settingsHeld: false,
    forceStop: false,
    opening: false,
    browser: false,
    suggestedReply: null,
    createdAt: DateTime.makeUnsafe(0),
  },
  lastEntry: null,
  lastActivityAt: null,
  unread: false,
});

const run = (change: Partial<RoutineRun>): RoutineRun => ({
  id: RoutineRunId.make("run"),
  startedAt: DateTime.makeUnsafe(1_000),
  finishedAt: DateTime.makeUnsafe(2_000),
  status: "delivered",
  attempts: 1,
  delivered: [said],
  note: null,
  ...change,
});

const routine = (lastRun: RoutineRun | null): Routine => ({
  id: digest,
  botId: ada,
  name: "Digest",
  instruction: "Sum up the day.",
  trigger: { _tag: "schedule", cron: "0 9 * * *", timeZone: "UTC" },
  enabled: true,
  webhookUrl: null,
  nextRunAt: null,
  lastRun,
  runCount: 1,
});

const words: WidgetWords = {
  working: "Working",
  waiting: "Waiting for you",
  quiet: "Quiet",
  ran: "Ran {when}",
  running: "Running now",
  neverRan: "Hasn’t run yet",
  botGone: "This bot was removed.",
  routineGone: "This routine was removed.",
  pickAnother: "Pick another",
  notPaired: "Not connected.",
  openApp: "Open J3 Bots",
  notYet: "Open J3 Bots once.",
  notSetUp: "Tap to choose.",
};
const base = { language: "en", words };

const linkText = (link: AppLink) =>
  link._tag === "bot" ? `bot/${link.botId}` : `routine/${link.botId}/${link.routineId}`;

const facts = (change: Partial<WidgetFacts>): WidgetFacts => ({
  roster: [bot()],
  routines: new Map(),
  results: new Map(),
  runText: (given) => `run ${given.status}`,
  link: linkText,
  now: 5_000,
  ...change,
});

const loaded = (routines: ReadonlyArray<Routine>): Loaded<ReadonlyArray<Routine>> => ({
  _tag: "ready",
  value: routines,
  stale: false,
});

const botTarget = { kind: "bot", botId: ada } as const;
const routineTarget = { kind: "routine", botId: ada, routineId: digest } as const;

describe("widgetSnapshot", () => {
  it("names a bot's light by what the operator would act on", () => {
    const waiting = widgetSnapshot(
      [botTarget],
      facts({ roster: [bot({ _tag: "waiting", entryId: said, since: null })] }),
      base,
    );
    expect(waiting?.bots[ada]).toEqual({
      gone: false,
      name: "Ada",
      light: "waiting",
      learnedAt: 5_000,
      link: "bot/ada",
    });
  });

  it("says a bot or a routine is gone once the roster no longer lists its bot", () => {
    const snapshot = widgetSnapshot([botTarget, routineTarget], facts({ roster: [] }), base);
    expect(snapshot?.bots[ada]).toEqual({ gone: true });
    expect(snapshot?.routines[digest]).toEqual({ gone: true });
  });

  it("says a routine is gone once its bot no longer has it", () => {
    const snapshot = widgetSnapshot(
      [routineTarget],
      facts({ routines: new Map([[ada, loaded([])]]) }),
      base,
    );
    expect(snapshot?.routines[digest]).toEqual({ gone: true });
  });

  it("waits while a routine it shows is loading, so a widget keeps what it showed", () => {
    expect(
      widgetSnapshot(
        [routineTarget],
        facts({ routines: new Map([[ada, { _tag: "loading" }]]) }),
        base,
      ),
    ).toBeNull();
  });

  it("shows the start of what a routine said, and opens the conversation it said it in", () => {
    const snapshot = widgetSnapshot(
      [routineTarget],
      facts({
        routines: new Map([[ada, loaded([routine(run({}))])]]),
        results: new Map([[said, "Three things today:\n\n- the build\n- the call"]]),
      }),
      base,
    );
    expect(snapshot?.routines[digest]).toEqual({
      gone: false,
      name: "Digest",
      lastRunAt: 1_000,
      running: false,
      result: "Three things today: - the build - the call",
      link: "bot/ada",
    });
  });

  it("words a run that said nothing, and opens the routine's runs", () => {
    const snapshot = widgetSnapshot(
      [routineTarget],
      facts({
        routines: new Map([[ada, loaded([routine(run({ status: "failed", delivered: [] }))])]]),
      }),
      base,
    );
    expect(snapshot?.routines[digest]).toMatchObject({
      result: "run failed",
      link: "routine/ada/digest",
    });
  });

  it("falls back to the run in words when the message it sent cannot be read", () => {
    const snapshot = widgetSnapshot(
      [routineTarget],
      facts({ routines: new Map([[ada, loaded([routine(run({}))])]]) }),
      base,
    );
    expect(snapshot?.routines[digest]).toMatchObject({ result: "run delivered" });
  });

  it("shows a silent run's note, and nothing for a run still going", () => {
    const silent = widgetSnapshot(
      [routineTarget],
      facts({
        routines: new Map([
          [ada, loaded([routine(run({ status: "silent", delivered: [], note: "All quiet." }))])],
        ]),
      }),
      base,
    );
    expect(silent?.routines[digest]).toMatchObject({ result: "All quiet." });
    const going = widgetSnapshot(
      [routineTarget],
      facts({
        routines: new Map([
          [ada, loaded([routine(run({ status: "running", delivered: [], finishedAt: null }))])],
        ]),
      }),
      base,
    );
    expect(going?.routines[digest]).toMatchObject({ running: true, result: "" });
  });
});

describe("resultStart", () => {
  it("leaves out code and cuts a long result at the length a widget is given", () => {
    expect(resultStart("Done.\n```\nnpm test\n```\nAll green.")).toBe("Done. All green.");
    const long = resultStart("word ".repeat(200));
    expect(long.length).toBeLessThanOrEqual(RESULT_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("snapshotKey", () => {
  const at = (now: number, state: BotState) =>
    widgetSnapshot([botTarget], facts({ now, roster: [bot(state)] }), base);

  it("tells snapshots apart by what they show, not by when a state was learned", () => {
    const first = at(1, { _tag: "idle" });
    const later = at(2, { _tag: "idle" });
    const blocked = at(2, { _tag: "blocked", failure: "provider-error", retryAt: null });
    if (first === null || later === null || blocked === null) throw new Error("no snapshot");
    expect(snapshotKey(later, [])).toBe(snapshotKey(first, []));
    expect(snapshotKey(blocked, [])).not.toBe(snapshotKey(first, []));
  });

  it("tells a bot's work apart once a widget would take it as old", () => {
    const working: BotState = {
      _tag: "thinking",
      since: DateTime.makeUnsafe(0),
      stalled: false,
      quietSince: null,
      typing: false,
      retrying: false,
    };
    const first = at(0, working);
    const soon = at(60_000, working);
    const long = at(WORKING_HOLDS / 2, working);
    if (first === null || soon === null || long === null) throw new Error("no snapshot");
    expect(snapshotKey(soon, [])).toBe(snapshotKey(first, []));
    expect(snapshotKey(long, [])).not.toBe(snapshotKey(first, []));
  });

  it("tells a new face apart", () => {
    const snapshot = at(1, { _tag: "idle" });
    if (snapshot === null) throw new Error("no snapshot");
    const face = { botId: ada, avatar: { shape: "dome", color: "cobalt" }, state: "idle" } as const;
    expect(
      snapshotKey(snapshot, [{ ...face, avatar: { shape: "dome", color: "coral" } }]),
    ).not.toBe(snapshotKey(snapshot, [face]));
  });
});
