// SPDX-License-Identifier: AGPL-3.0-or-later
import { type LittleOne, LittleOneId, type PlanStep, type TurnWork } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import { planProgress, shownLittleOnes, shownPlan } from "./turnWork.ts";

const step = (text: string, status: PlanStep["status"]): PlanStep => ({ text, status });

const littleOne = (id: string, status: LittleOne["status"]): LittleOne => ({
  id: LittleOneId.make(id),
  label: `Look into ${id}`,
  status,
  startedAt: at("2026-11-20T14:00:00Z"),
  finishedAt: status === "working" ? null : at("2026-11-20T14:05:00Z"),
});

describe("a turn's plan", () => {
  it("is drawn as a checklist from two steps on", () => {
    const work = (steps: TurnWork["plan"]): TurnWork => ({
      plan: steps,
      littleOnes: { ones: [], working: 0, total: 0 },
    });
    const one = { steps: [step("Fix the build", "running")] } as const;
    const two = { steps: [step("Fix the build", "done"), step("Ship it", "running")] } as const;

    expect(shownPlan(work(one))).toBeNull();
    expect(shownPlan(work(two))).toBe(two);
  });

  it("counts its steps done, and one of a status it cannot read as still to do", () => {
    const plan = {
      steps: [step("Draft", "done"), step("Review", "unknown"), step("Send", "done")],
    } as const;

    expect(planProgress(plan)).toEqual({ done: 2, total: 3 });
  });
});

describe("a turn's little ones", () => {
  it("draws the first four still working and tells the rest as more", () => {
    const ones = [
      littleOne("a", "done"),
      littleOne("b", "working"),
      littleOne("c", "failed"),
      littleOne("d", "working"),
      littleOne("e", "working"),
      littleOne("f", "working"),
      littleOne("g", "working"),
    ];

    // Two more work than the turn's work lists by name.
    const { shown, more } = shownLittleOnes({ ones, working: 7, total: 9 });

    expect(shown.map((one) => one.id)).toEqual(["b", "d", "e", "f"]);
    expect(more).toBe(3);
  });

  it("draws none once every one has gone back", () => {
    const ones = [littleOne("a", "done"), littleOne("b", "unknown")];

    expect(shownLittleOnes({ ones, working: 0, total: 2 })).toEqual({ shown: [], more: 0 });
  });
});
