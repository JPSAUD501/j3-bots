// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserTabRef } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Cell } from "./Store.ts";
import type { BrowserPicture, BrowserViewState } from "./stores/Browser.ts";
import { oneAtATime, takeStill } from "./stills.ts";

const ref = BrowserTabRef.make("tab_a");
const size = { maxWidth: 400 };
const stateOf = (status: BrowserViewState["status"]): BrowserViewState => ({
  status,
  viewport: null,
  control: null,
});

/** A view the test drives, and whether it was closed. */
const fakeView = () => {
  const picture = new Cell<BrowserPicture | null>(null);
  const state = new Cell<BrowserViewState>(stateOf({ _tag: "connecting" }));
  const closed = { value: false };
  return {
    picture,
    state,
    closed,
    open: () => ({
      picture,
      state,
      close: () => {
        closed.value = true;
      },
    }),
  };
};

describe("a still", () => {
  it("keeps the first picture and closes its view", async () => {
    const view = fakeView();
    const still = takeStill(view.open, ref, size, new AbortController().signal);
    view.state.set(stateOf({ _tag: "live" }));
    view.picture.set({ jpeg: new Uint8Array([1, 2]), sequence: 1 });
    expect(await still).toEqual(new Uint8Array([1, 2]));
    expect(view.closed.value).toBe(true);
  });

  it("ends without a picture once its socket drops, never opening another", async () => {
    const view = fakeView();
    const still = takeStill(view.open, ref, size, new AbortController().signal);
    view.state.set(stateOf({ _tag: "reconnecting" }));
    expect(await still).toBeNull();
    expect(view.closed.value).toBe(true);
  });

  it("closes its view at once when stopped", async () => {
    const view = fakeView();
    const stop = new AbortController();
    const still = takeStill(view.open, ref, size, stop.signal);
    stop.abort();
    expect(await still).toBeNull();
    expect(view.closed.value).toBe(true);
  });
});

describe("stills in a line", () => {
  it("start one after another, and one that fails lets the next go", async () => {
    const line = oneAtATime();
    const order: Array<string> = [];
    let release = () => {};
    const first = line(
      () =>
        new Promise<string>((resolve) => {
          order.push("first starts");
          release = () => resolve("first");
        }),
    );
    const failing = line(() => Promise.reject(new Error("no picture")));
    const third = line(() => {
      order.push("third starts");
      return Promise.resolve("third");
    });
    await Promise.resolve();
    expect(order).toEqual(["first starts"]);
    release();
    expect(await first).toBe("first");
    await expect(failing).rejects.toThrow("no picture");
    expect(await third).toBe("third");
    expect(order).toEqual(["first starts", "third starts"]);
  });
});
