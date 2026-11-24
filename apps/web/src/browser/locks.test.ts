// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { holdLock, whileFree } from "./locks";

afterEach(() => vi.unstubAllGlobals());

const browsers = [
  ["with Web Locks", () => {}],
  ["without Web Locks", () => vi.stubGlobal("navigator", {})],
] as const;

describe.each(browsers)("a tab’s lock, %s", (browser, setUp) => {
  it("opens a view only once the still taking a picture of its tab let its socket go", async () => {
    setUp();
    const name = `still-then-view ${browser}`;
    const order: Array<string> = [];
    let running = () => {};
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });
    const still = whileFree(
      name,
      (stop) =>
        new Promise<string>((resolve) => {
          running();
          stop.addEventListener("abort", () => {
            order.push("still closed");
            resolve("stopped");
          });
        }),
    );
    await started;
    const release = holdLock(name, () => order.push("view opened"));
    await vi.waitFor(() => expect(order).toEqual(["still closed", "view opened"]));
    expect(await still).toBe("stopped");
    release();
  });

  it("lets two views of one tab open together", async () => {
    setUp();
    const name = `two-views ${browser}`;
    const opened: Array<string> = [];
    const first = holdLock(name, () => opened.push("first"));
    const second = holdLock(name, () => opened.push("second"));
    await vi.waitFor(() => expect(opened).toEqual(["first", "second"]));
    first();
    second();
  });
});
