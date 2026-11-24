// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserViewHandle,
  type BrowserViewState,
  type BrowserViewStatus,
  Cell,
} from "@j3-bots/client-runtime";
import { type BrowserController, BrowserTabRef } from "@j3-bots/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { keptViews, viewLockName } from "./kept";
import { whileFree } from "./locks";

const tab = BrowserTabRef.make("tab_kept");

/** A view's socket, as the network would leave it: its state is set by the test. */
const socket = (controller: BrowserController) => {
  const state = new Cell<BrowserViewState>({
    status: { _tag: "live" },
    viewport: { width: 1280, height: 800 },
    control: { controller, generation: 1, dialog: null },
  });
  const opened = { open: true };
  const view: BrowserViewHandle = {
    state,
    picture: new Cell(null),
    probe: new Cell(null),
    cursor: new Cell(null),
    onProbe: () => () => {},
    onCursor: () => () => {},
    ack: () => {},
    send: () => {},
    close: () => {
      opened.open = false;
    },
  };
  const set = (status: BrowserViewStatus, next: BrowserController = controller) =>
    state.set({
      ...state.get(),
      status,
      control: { controller: next, generation: 2, dialog: null },
    });
  return { view, opened, set };
};

// Other windows are the Web Locks API's to keep apart; this window's own views and stills are these.
beforeEach(() => {
  vi.stubGlobal("navigator", {});
  return () => vi.unstubAllGlobals();
});

/** Whether a still of the tab could open now. */
const stillOpens = () => whileFree(viewLockName(tab), () => Promise.resolve(true));

describe("a tab kept while the operator holds it", () => {
  it("stays open through a reconnect, and keeps a still from taking its place", async () => {
    const kept = keptViews();
    const held = socket("you");
    kept.keep(tab, held.view);
    held.set({ _tag: "reconnecting" }, "you");
    expect(held.opened.open).toBe(true);
    expect(await stillOpens()).toBeNull();
    kept.dropAll();
    expect(held.opened.open).toBe(false);
    expect(await stillOpens()).toBe(true);
  });

  it.each<[string, BrowserViewStatus, BrowserController]>([
    ["the next view of it took its place", { _tag: "replaced" }, "you"],
    ["the tab closed", { _tag: "gone" }, "you"],
    ["the bot has it back", { _tag: "live" }, "bot"],
    ["another device took it", { _tag: "live" }, "another-device"],
  ])("closes once %s", async (_, status, controller) => {
    const kept = keptViews();
    const held = socket("you");
    kept.keep(tab, held.view);
    held.set(status, controller);
    expect(held.opened.open).toBe(false);
    expect(await stillOpens()).toBe(true);
  });

  it("makes way for a new view of the tab only when its own socket is connecting again", () => {
    const kept = keptViews();
    const live = socket("you");
    kept.keep(tab, live.view);
    kept.makeWay(tab);
    expect(live.opened.open).toBe(true);
    live.set({ _tag: "reconnecting" }, "you");
    kept.makeWay(tab);
    expect(live.opened.open).toBe(false);
  });

  it("is not kept when the operator no longer holds it", () => {
    const kept = keptViews();
    const watched = socket("bot");
    kept.keep(tab, watched.view);
    expect(watched.opened.open).toBe(false);
  });
});
