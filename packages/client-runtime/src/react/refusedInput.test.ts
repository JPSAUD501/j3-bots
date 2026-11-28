// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Cell } from "../Store.ts";
import type { BrowserRefusal } from "../stores/Browser.ts";
import { followRefusals, REFUSAL_SHOWN_MS } from "./refusedInput.ts";

describe("followRefusals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A view's refusals, and what the line was told of them. */
  const scene = (before: BrowserRefusal | null = null) => {
    const refused = new Cell<BrowserRefusal | null>(before);
    const said: Array<BrowserRefusal["reason"] | null> = [];
    const stop = followRefusals(refused, (reason) => said.push(reason));
    return { refused, said, stop };
  };

  it("says a refusal, then nothing once the time is up", () => {
    const { refused, said } = scene();
    refused.set({ reason: "away", sequence: 1 });
    expect(said).toEqual(["away"]);
    vi.advanceTimersByTime(REFUSAL_SHOWN_MS);
    expect(said).toEqual(["away", null]);
  });

  it("keeps it said while refusals keep coming", () => {
    const { refused, said } = scene();
    refused.set({ reason: "away", sequence: 1 });
    vi.advanceTimersByTime(REFUSAL_SHOWN_MS - 1);
    refused.set({ reason: "parked", sequence: 2 });
    vi.advanceTimersByTime(REFUSAL_SHOWN_MS - 1);
    expect(said).toEqual(["away", "parked"]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["away", "parked", null]);
  });

  it("passes over a refusal heard before it began", () => {
    const { refused, said } = scene({ reason: "away", sequence: 3 });
    refused.set({ reason: "away", sequence: 3 });
    expect(said).toEqual([]);
    refused.set({ reason: "parked", sequence: 4 });
    expect(said).toEqual(["parked"]);
  });

  it("says nothing more once stopped", () => {
    const { refused, said, stop } = scene();
    refused.set({ reason: "away", sequence: 1 });
    stop();
    vi.advanceTimersByTime(REFUSAL_SHOWN_MS);
    refused.set({ reason: "away", sequence: 2 });
    expect(said).toEqual(["away"]);
  });
});
