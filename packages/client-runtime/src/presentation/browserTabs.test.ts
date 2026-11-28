// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  BROWSER_PERSON_HOLD_MS,
  BrowserTabRef,
  DeviceId,
  type SharedBrowserTab,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  botsTab,
  botViewerTab,
  followedBot,
  frozenOf,
  holdEnd,
  listedTabs,
  neighborTab,
  nextLineChange,
  NO_PAGE_USE,
  NO_PAGE_USE_STATE,
  type PageUseEvent,
  pageUseStep,
  sharedViewerTab,
  shownTab,
  tabAfterClose,
  tabFaces,
  tabLine,
  type ViewerTab,
} from "./browserTabs.ts";

const ana = BotId.make("bot_ana");
const lia = BotId.make("bot_lia");
const here = DeviceId.make("dev_phone");
const laptop = DeviceId.make("dev_laptop");
const now = 1_800_000_000_000;

const shared = (changes: Partial<SharedBrowserTab> = {}): SharedBrowserTab => ({
  ref: BrowserTabRef.make("tab_a"),
  url: "https://bakery.example/orders",
  title: "Orders",
  loading: false,
  where: { kind: "desktop", device: laptop },
  openedBy: { kind: "bot", botId: ana },
  onIt: [ana, lia],
  acting: null,
  heldBy: null,
  dialog: null,
  private: false,
  ...changes,
});

const viewerTab = (changes: Partial<SharedBrowserTab> = {}) =>
  sharedViewerTab(shared(changes), here);
const inputAt = (at: number) => ({ ...NO_PAGE_USE, lastInputAt: at });

describe("the tab's line", () => {
  it("names who acts, and only the names while the bots are on it doing nothing", () => {
    expect(tabLine(viewerTab({ acting: lia }), NO_PAGE_USE, now)).toEqual({
      _tag: "acting",
      bots: [ana, lia],
      acting: lia,
    });
    expect(tabLine(viewerTab(), NO_PAGE_USE, now)).toEqual({ _tag: "on-it", bots: [ana, lia] });
    expect(tabLine(viewerTab({ onIt: [] }), NO_PAGE_USE, now)).toEqual({ _tag: "empty" });
  });

  it("says the bots wait from the moment this device touches the page, before the server says so", () => {
    expect(tabLine(viewerTab({ acting: ana }), inputAt(now), now)._tag).toBe("waits-for-you");
  });

  it("counts the last three seconds of the hold down, then gives the line back", () => {
    const use = inputAt(now);
    const end = now + BROWSER_PERSON_HOLD_MS;
    expect(tabLine(viewerTab(), use, end - 3_000)).toEqual({
      _tag: "back-in",
      bots: [ana, lia],
      seconds: 3,
    });
    expect(tabLine(viewerTab(), use, end - 2_500)).toMatchObject({ seconds: 3 });
    expect(tabLine(viewerTab(), use, end - 1)).toMatchObject({ seconds: 1 });
    expect(tabLine(viewerTab(), use, end)._tag).toBe("on-it");
  });

  it("follows the server's end of the hold when it is later than this device's own", () => {
    const until = DateTime.makeUnsafe(now + 20_000);
    const tab = viewerTab({ heldBy: { kind: "person", device: here, until } });
    expect(tabLine(tab, inputAt(now), now + 15_000)._tag).toBe("waits-for-you");
    expect(tabLine(tab, NO_PAGE_USE, now + 18_000)).toMatchObject({ seconds: 2 });
  });

  it("holds with no countdown while the keyboard is up, and waits for Continue after Wait for me", () => {
    const tab = viewerTab();
    expect(tabLine(tab, { ...inputAt(now), keyboard: true }, now + 60_000)._tag).toBe(
      "waits-for-you",
    );
    expect(tabLine(tab, { ...NO_PAGE_USE, waiting: true }, now)._tag).toBe("waits-until-continue");
    const held = viewerTab({ heldBy: { kind: "person", device: here, until: null } });
    expect(tabLine(held, NO_PAGE_USE, now)._tag).toBe("waits-until-continue");
  });

  it("says the page is in use elsewhere while another device holds it, whatever this one did", () => {
    const tab = viewerTab({
      heldBy: { kind: "person", device: laptop, until: DateTime.makeUnsafe(now + 5_000) },
    });
    expect(tabLine(tab, inputAt(now), now)._tag).toBe("elsewhere");
  });

  it("changes by itself only at the countdown's start and each of its seconds", () => {
    const use = inputAt(now);
    const end = now + BROWSER_PERSON_HOLD_MS;
    expect(nextLineChange(viewerTab(), use, now)).toBe(end - 3_000);
    expect(nextLineChange(viewerTab(), use, end - 3_000)).toBe(end - 2_000);
    expect(nextLineChange(viewerTab(), use, end - 2_400)).toBe(end - 2_000);
    expect(nextLineChange(viewerTab(), NO_PAGE_USE, now)).toBeNull();
    expect(nextLineChange(viewerTab(), { ...use, keyboard: true }, now)).toBeNull();
  });
});

describe("a tab from a server before shared tabs", () => {
  it("has its one bot on it, acting while it controls the tab, held here while this device has it", () => {
    const tab = {
      ref: BrowserTabRef.make("tab_old"),
      botId: ana,
      url: "",
      title: "",
      loading: false,
      controller: "bot",
      front: true,
    } as const;
    expect(botViewerTab(tab, here)).toMatchObject({ onIt: [ana], acting: ana, where: null });
    expect(botViewerTab({ ...tab, controller: "you" }, here).holder).toEqual({ _tag: "taken" });
  });

  it("ends the hold of a tab taken there 10 s after this device's last input, as on any server", () => {
    const taken = botViewerTab(
      {
        ref: BrowserTabRef.make("tab_old"),
        botId: ana,
        url: "",
        title: "",
        loading: false,
        controller: "you",
        front: true,
      },
      here,
    );
    const end = now + BROWSER_PERSON_HOLD_MS;
    expect(holdEnd(taken, inputAt(now), now)).toBe(end);
    expect(tabLine(taken, inputAt(now), end - 1_000)).toEqual({
      _tag: "back-in",
      bots: [ana],
      seconds: 1,
    });
    expect(holdEnd(taken, inputAt(now), end)).toBe("none");
    // Taken with nothing done here since, as before the app restarted: nothing holds it here.
    expect(holdEnd(taken, NO_PAGE_USE, now)).toBe("none");
  });
});

describe("faces and following", () => {
  it("lights the acting bot, and the one that waits for the person in amber", () => {
    expect(tabFaces(viewerTab({ acting: ana }), new Set([lia]))).toEqual([
      { botId: ana, light: "acting" },
      { botId: lia, light: "waiting" },
    ]);
  });

  it("never shows a face on a private tab", () => {
    expect(viewerTab({ private: true, acting: ana }).onIt).toEqual([]);
  });

  it("follows the bot the person came from while it is on the tab, else the acting one", () => {
    expect(followedBot(viewerTab({ acting: ana }), lia)).toBe(lia);
    expect(followedBot(viewerTab({ acting: ana, onIt: [ana] }), lia)).toBe(ana);
    expect(followedBot(viewerTab({ onIt: [] }), null)).toBeNull();
  });
});

describe("the tabs", () => {
  const tab = (name: string, changes: Partial<SharedBrowserTab> = {}): ViewerTab =>
    viewerTab({ ref: BrowserTabRef.make(name), ...changes });
  const [a, b, c] = [tab("a", { onIt: [lia] }), tab("b", { onIt: [ana, lia] }), tab("c")];

  it("finds the tab a bot's card shows: where it acts, else where it was last", () => {
    expect(botsTab([a, b], lia)?.ref).toBe(a.ref);
    expect(botsTab([a, tab("b", { acting: lia })], lia)?.ref).toBe("b");
    expect(botsTab([a], ana)).toBeNull();
  });

  it("swipes to the neighbor, and stops at the ends", () => {
    expect(neighborTab([a, b, c], b.ref, 1)?.ref).toBe(c.ref);
    expect(neighborTab([a, b, c], a.ref, -1)).toBeNull();
  });

  it("lists neither private tabs nor those closing for Undo", () => {
    const hidden = tab("p", { private: true });
    expect(listedTabs([a, hidden, b], new Set([a.ref])).map((each) => each.ref)).toEqual([b.ref]);
  });

  it("shows the tab that took the closed one's place, else the one before it", () => {
    expect(tabAfterClose([a, b, c], [a, c], b.ref)?.ref).toBe(c.ref);
    expect(tabAfterClose([a, b, c], [a, b], c.ref)?.ref).toBe(b.ref);
    expect(tabAfterClose([a], [], a.ref)).toBeNull();
  });
});

describe("a frozen picture", () => {
  it("says this device is offline first, then that the computer went away", () => {
    const parked = viewerTab({ where: { kind: "parked" } });
    expect(frozenOf({ tab: parked, online: false, status: "live" })._tag).toBe("you-offline");
    expect(frozenOf({ tab: parked, online: true, status: "live" })._tag).toBe("parked");
    expect(frozenOf({ tab: viewerTab(), online: true, status: "reconnecting" })._tag).toBe(
      "reconnecting",
    );
    expect(frozenOf({ tab: viewerTab(), online: true, status: "live" })._tag).toBe("live");
  });
});

describe("what the person's use of a page sends", () => {
  const click = {
    type: "pointer",
    action: "down",
    x: 10,
    y: 10,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
  } as const;
  const hover = { ...click, action: "move", button: "none", buttons: 0 } as const;
  const run = (shared: boolean, events: ReadonlyArray<PageUseEvent>) =>
    events.reduce(
      (done, event, index) => {
        const next = pageUseStep(done.state, event, shared, now + index);
        return { state: next.state, sent: [...done.sent, ...next.send.map((frame) => frame.type)] };
      },
      { state: NO_PAGE_USE_STATE, sent: [] as ReadonlyArray<string> },
    );

  it("sends input alone to a server that shares its tabs: touching is taking", () => {
    expect(run(true, [{ _tag: "input", input: click }]).sent).toEqual(["pointer"]);
  });

  it("takes the tab first from a server before, once, and gives it back when the hold ends", () => {
    const touched = run(false, [
      { _tag: "input", input: click },
      { _tag: "input", input: click },
      { _tag: "hold-ended" },
    ]);
    expect(touched.sent).toEqual(["take", "pointer", "pointer", "release"]);
  });

  it("drops Wait for me once another device is seen holding the tab", () => {
    const refused = run(true, [{ _tag: "wait-for-me" }, { _tag: "held-elsewhere" }]);
    expect(refused.sent).toEqual(["take"]);
    expect(refused.state).toEqual(NO_PAGE_USE_STATE);
  });

  it("never holds the tab for a pointer that only moves", () => {
    const moved = run(false, [{ _tag: "input", input: hover }]);
    expect(moved.sent).toEqual(["pointer"]);
    expect(moved.state.use.lastInputAt).toBeNull();
  });

  it("holds while the keyboard is up, and keeps the usual hold from when it goes down", () => {
    const typed = run(true, [
      { _tag: "keyboard", up: true },
      { _tag: "keyboard", up: false },
    ]);
    expect(typed.sent).toEqual(["take", "release"]);
    expect(typed.state.use).toEqual({ lastInputAt: now + 1, waiting: false, keyboard: false });
    expect(pageUseStep(typed.state, { _tag: "keyboard", up: false }, true, now).send).toEqual([]);
    expect(
      pageUseStep(
        { ...NO_PAGE_USE_STATE, use: { ...NO_PAGE_USE, keyboard: true } },
        { _tag: "keyboard", up: false },
        true,
        now,
      ).send,
    ).toEqual([{ type: "release", idle: true }]);
  });

  it("keeps Wait for me through the keyboard, until Continue", () => {
    const waited = run(true, [
      { _tag: "wait-for-me" },
      { _tag: "keyboard", up: true },
      { _tag: "keyboard", up: false },
    ]);
    expect(waited.sent).toEqual(["take"]);
    expect(tabLine(viewerTab(), waited.state.use, now + 60_000)._tag).toBe("waits-until-continue");
    expect(run(true, [{ _tag: "wait-for-me" }, { _tag: "give-back" }]).sent).toEqual([
      "take",
      "release",
    ]);
  });

  it("gives the tab back on leaving only when this view held it", () => {
    expect(run(true, [{ _tag: "leave" }]).sent).toEqual([]);
    expect(run(true, [{ _tag: "input", input: click }, { _tag: "leave" }]).sent).toEqual([
      "pointer",
      "release",
    ]);
  });
});

describe("the tab a live view shows", () => {
  const tab = (ref: string, onIt: ReadonlyArray<BotId> = []) =>
    viewerTab({ ref: BrowserTabRef.make(ref), onIt });
  const [a, b, c] = [tab("tab_a"), tab("tab_b", [lia]), tab("tab_c")];

  it("opens on the tab of the bot the person came from, else the first", () => {
    const opening = { shown: { ref: null, fresh: false }, before: null, after: [a, b, c] };
    expect(shownTab({ ...opening, from: lia }).ref).toBe(b.ref);
    expect(shownTab({ ...opening, from: ana }).ref).toBe(a.ref);
  });

  it("keeps its tab through changes, and moves to the one in its place once it closes", () => {
    const shown = { ref: b.ref, fresh: false };
    expect(shownTab({ shown, before: [a, b, c], after: [c, b], from: null }).ref).toBe(b.ref);
    expect(shownTab({ shown, before: [a, b, c], after: [a, c], from: null }).ref).toBe(c.ref);
  });

  it("waits for a tab the person just opened, until the list holds it", () => {
    const fresh = { ref: BrowserTabRef.make("tab_new"), fresh: true };
    expect(shownTab({ shown: fresh, before: [a], after: [a], from: null })).toEqual(fresh);
    const arrived = shownTab({ shown: fresh, before: [a], after: [a, tab("tab_new")], from: null });
    expect(arrived).toEqual({ ref: fresh.ref, fresh: false });
  });

  it("opens on the first tab when the one it was opened on is not listed", () => {
    const missing = { ref: BrowserTabRef.make("tab_gone"), fresh: false };
    expect(shownTab({ shown: missing, before: null, after: [a, b], from: null }).ref).toBe(a.ref);
  });
});
