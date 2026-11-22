// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, EntryOrder, type WorkFoldEntry } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../../test/fixtures.ts";
import { workFoldTitle } from "./work.ts";

const ctx = context("2026-11-20T15:00:00Z", "en", {});

const fold = (status: WorkFoldEntry["status"]): WorkFoldEntry => ({
  _tag: "work-fold",
  id: EntryId.make("fold"),
  order: EntryOrder.make(1),
  author: { _tag: "system" },
  createdAt: at("2026-11-20T14:00:00Z"),
  status,
  stepCount: 3,
});

const finished = (finishedAt: string, waitedMs: number, background = false) =>
  fold({ _tag: "finished", finishedAt: at(finishedAt), ending: "completed", waitedMs, background });

describe("workFoldTitle", () => {
  it("gives no duration while the turn runs, nor while the work it handed off still runs", () => {
    expect(workFoldTitle(fold({ _tag: "running" }), ctx)).toBe("Working");
    const handedOff = workFoldTitle(finished("2026-11-20T14:05:00Z", 0, true), ctx);
    expect(handedOff).not.toMatch(/\d/);
  });

  it("counts the turn's time less what it spent waiting on the operator", () => {
    expect(plain(workFoldTitle(finished("2026-11-20T14:05:00Z", 0), ctx))).toBe("Worked for 5m");
    expect(plain(workFoldTitle(finished("2026-11-20T14:05:00Z", 3 * 60_000), ctx))).toBe(
      "Worked for 2m",
    );
  });
});
