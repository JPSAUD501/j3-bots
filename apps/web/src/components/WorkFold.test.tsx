// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EntryId,
  EntryOrder,
  LittleOneId,
  type LittleOne,
  type TurnWork,
  type WorkFoldEntry,
} from "@j3-bots/contracts";
import { at, bot } from "@j3-bots/client-runtime/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { WorkFold } from "./WorkFold";

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const started = at("2026-11-20T10:00:00Z");
const scout = bot("Scout", {
  _tag: "working",
  since: started,
  stalled: false,
  quietSince: null,
  typing: false,
  retrying: false,
  activity: null,
  activityKind: null,
  tool: null,
  littleOnes: 2,
});

const little = (label: string, status: LittleOne["status"]): LittleOne => ({
  id: LittleOneId.make(label),
  label,
  status,
  startedAt: started,
  finishedAt: status === "working" ? null : at("2026-11-20T10:01:00Z"),
});

const work: TurnWork = {
  plan: {
    steps: [
      { text: "Read the brief", status: "done" },
      { text: "Compare the vendors", status: "running" },
    ],
  },
  littleOnes: {
    ones: [
      little("Checking prices", "working"),
      little("Reading reviews", "done"),
      little("Looking into support", "working"),
    ],
    working: 5,
    total: 6,
  },
};

const fold = (turn: TurnWork, live: boolean): WorkFoldEntry => ({
  _tag: "work-fold",
  id: EntryId.make("fold"),
  order: EntryOrder.make(10),
  author: { _tag: "bot", botId: scout.id },
  createdAt: at("2026-11-20T10:00:05Z"),
  turnStartedAt: started,
  stepCount: 3,
  apps: [],
  work: turn,
  status: live
    ? { _tag: "running" }
    : {
        _tag: "finished",
        finishedAt: at("2026-11-20T10:02:00Z"),
        ending: "completed",
        waitedMs: 0,
        waitedBeforeMs: 0,
        background: false,
      },
});

const row = (turn: TurnWork, live: boolean) =>
  renderToStaticMarkup(
    <WorkFold
      fold={fold(turn, live)}
      live={live ? { bot: scout, lastEntry: null } : null}
      steps={null}
      onOpenChange={() => {}}
      onOpenImage={() => {}}
    />,
  );

describe("a turn's row", () => {
  it("shows a running turn's plan step by step, and a line for each little one at work", () => {
    const html = row(work, true);
    expect(html).toContain("Read the brief");
    expect(html).toContain("Compare the vendors");
    expect(html).toContain("Checking prices");
    expect(html).toContain("Looking into support");
    // One that ended before it was seen is never drawn, and the ones not listed are counted.
    expect(html).not.toContain("Reading reviews");
    expect(html).toContain("+3 more");
  });

  it("folds an ended turn's plan into one line, and draws no little one", () => {
    const html = row(work, false);
    expect(html).toContain("Plan, 1 of 2 done");
    expect(html).not.toContain("Checking prices");
  });

  it("does not draw a plan of one step as a plan", () => {
    const html = row(
      {
        plan: { steps: [{ text: "Reply to the question", status: "running" }] },
        littleOnes: work.littleOnes,
      },
      true,
    );
    expect(html).not.toContain("Reply to the question");
    expect(html).toContain("Checking prices");
  });
});
