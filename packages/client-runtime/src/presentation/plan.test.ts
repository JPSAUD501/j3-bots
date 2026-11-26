// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Plan, PlanStep } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { liveLine, planLines, planWindow } from "./plan.ts";

const step = (text: string, status: PlanStep["status"] = "pending"): PlanStep => ({ text, status });
const plan = (first: PlanStep, ...rest: ReadonlyArray<PlanStep>): Plan => ({
  steps: [first, ...rest],
});
/** A plan of `total` steps, the first `done` of them done and the next one running. */
const long = (total: number, done: number): Plan => {
  const steps = Array.from({ length: total }, (_, i) =>
    step(`Step ${i + 1}`, i < done ? "done" : i === done ? "running" : "pending"),
  );
  const [first, ...rest] = steps;
  return plan(first ?? step("Step 1"), ...rest);
};

describe("a plan's lines", () => {
  it("draw a step whose status this build does not know as one still to do", () => {
    expect(planLines(plan(step("Read", "done"), step("Reply", "unknown")))[1]?.state).toBe(
      "pending",
    );
  });

  it("carry the live mark on the first step being done now", () => {
    expect(liveLine(planLines(long(5, 2)))).toBe(2);
    expect(liveLine(planLines(plan(step("Read", "done"), step("Reply"))))).toBeNull();
  });
});

describe("planWindow", () => {
  /** How many lines the card takes: its steps, and a line for each count of hidden ones. */
  const taken = (window: ReturnType<typeof planWindow>) =>
    window.lines.length + (window.before > 0 ? 1 : 0) + (window.after > 0 ? 1 : 0);

  it("shows a plan that fits whole", () => {
    expect(planWindow(long(6, 3))).toMatchObject({ before: 0, after: 0 });
    expect(planWindow(long(6, 3)).lines).toHaveLength(6);
  });

  it.each([0, 1, 5, 11, 18, 19])(
    "shows a plan of 20 around the step being done, %i done so far, in six lines",
    (done) => {
      const window = planWindow(long(20, done));
      expect(taken(window)).toBe(6);
      expect(window.before + window.lines.length + window.after).toBe(20);
      expect(window.lines.map((line) => line.index)).toContain(done);
      // The step before it shows too, so a step that just ended is seen checked.
      if (done > 0) expect(window.lines.map((line) => line.index)).toContain(done - 1);
    },
  );

  it("shows the end of a plan that is all done", () => {
    const window = planWindow(long(20, 20));
    expect(window.after).toBe(0);
    expect(window.lines.at(-1)?.index).toBe(19);
  });
});
