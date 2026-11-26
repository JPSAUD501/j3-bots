// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { holding } from "./held.ts";

/** Handles that record whether each is still held. */
const handles = () => {
  const opened: Array<{ readonly id: number; released: boolean }> = [];
  const open = () => {
    const record = { id: opened.length + 1, released: false };
    opened.push(record);
    return {
      id: record.id,
      release: () => {
        record.released = true;
      },
    };
  };
  return { opened, open };
};

describe("holding", () => {
  it("holds a handle while it is watched, and none before or after", () => {
    const { opened, open } = handles();
    const held = holding(open);
    expect(held.get()).toBeNull();
    expect(opened).toEqual([]);

    let told = 0;
    const stop = held.subscribe(() => {
      told += 1;
    });
    expect(held.get()?.id).toBe(1);
    expect(told).toBe(1);

    stop();
    expect(held.get()).toBeNull();
    expect(opened).toEqual([{ id: 1, released: true }]);
  });

  it("keeps the newer handle when an older watch stops after it began", () => {
    const { opened, open } = handles();
    const held = holding(open);
    const first = held.subscribe(() => {});
    const second = held.subscribe(() => {});
    first();
    expect(held.get()?.id).toBe(2);
    expect(opened[0]?.released).toBe(true);
    second();
    expect(held.get()).toBeNull();
  });
});
