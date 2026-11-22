// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { reanimatedSpring, springPath, springs } from "./springs.ts";

const pathOf = (easing: string) =>
  (/^linear\((.*)\)$/.exec(easing)?.[1] ?? "").split(", ").map(Number);

describe.each(Object.entries(springs))("the %s spring", (_, spring) => {
  const path = pathOf(spring.easing);

  it("starts at rest and ends exactly on its target", () => {
    expect(path[0]).toBe(0);
    expect(path.at(-1)).toBe(1);
    expect(path.every(Number.isFinite)).toBe(true);
  });

  it("has come to rest by its duration", () => {
    // Twice as long: the path past the duration must stay where it settled.
    const longer = springPath(spring.frequency, spring.damping, (spring.duration * 2) / 1000);
    const secondHalf = longer.slice(Math.ceil(longer.length / 2), -1);
    for (const position of secondHalf) expect(Math.abs(position - 1)).toBeLessThan(0.006);
  });

  it("drives Reanimated at the same frequency and damping ratio", () => {
    const { mass, stiffness, damping } = reanimatedSpring(spring);
    const omega = Math.sqrt(stiffness / mass);
    expect(omega / (2 * Math.PI)).toBeCloseTo(spring.frequency, 6);
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeCloseTo(spring.damping, 6);
  });
});

describe("the spring family", () => {
  const peak = (easing: string) => Math.max(...pathOf(easing));

  it("overshoots most on pop and barely on slide", () => {
    expect(peak(springs.pop.easing)).toBeGreaterThan(1.1);
    expect(peak(springs.soft.easing)).toBeGreaterThan(1.01);
    expect(peak(springs.slide.easing)).toBeLessThan(1.01);
  });

  it("settles fast enough for feedback", () => {
    for (const spring of Object.values(springs)) expect(spring.duration).toBeLessThan(1000);
  });
});
