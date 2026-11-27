// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BROWSER_PERSON_HOLD_MS,
  type BotId,
  type BrowserController,
  type BrowserInput,
  type BrowserTab,
  type BrowserTabHolder,
  type BrowserTabRef,
  type BrowserTabWhere,
  type DeviceId,
  type SharedBrowserTab,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";

// A tab as the phone and the web show it (browser-ux-v2, section 4): the
// faces of the bots on it, the one quiet line that says who acts and who
// waits, the countdown before the bots go on, and the order the person
// swipes through. A server that shares its tabs says all of it; one from
// before says only who controls the tab, which is read the same way.

/** Who holds a tab, from this device's point of view. */
export type TabHolder =
  | { readonly _tag: "nobody" }
  /** A bot's lease: it acts in turn. */
  | { readonly _tag: "bot"; readonly botId: BotId }
  /** The person on this device. `until` is when the hold ends, in epoch ms; null while they asked the bots to wait. */
  | { readonly _tag: "you"; readonly until: number | null }
  /** The person on another device. */
  | { readonly _tag: "elsewhere" }
  /** The server is typing a saved login. */
  | { readonly _tag: "fill" };

/** One tab, whichever server it came from. */
export interface ViewerTab {
  readonly ref: BrowserTabRef;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  /** Where it runs; null from a server before shared tabs, whose tabs are all its own. */
  readonly where: BrowserTabWhere | null;
  /** The bots on it, the most recent first: its faces. */
  readonly onIt: ReadonlyArray<BotId>;
  /** The bot whose action runs on it now. */
  readonly acting: BotId | null;
  readonly holder: TabHolder;
  /** Only the person sees it: no face ever shows on it. */
  readonly private: boolean;
}

const epochMs = (value: DateTime.Utc): number => DateTime.toEpochMillis(value);

/** The holder a server that shares its tabs names, from this device's point of view. */
const holderOf = (held: BrowserTabHolder | null, here: DeviceId | null): TabHolder => {
  if (held === null) return { _tag: "nobody" };
  switch (held.kind) {
    case "person":
      return held.device === here
        ? { _tag: "you", until: held.until === null ? null : epochMs(held.until) }
        : { _tag: "elsewhere" };
    case "bot":
      return { _tag: "bot", botId: held.botId };
    case "fill":
      return { _tag: "fill" };
  }
};

/** The holder of a tab of a server before shared tabs, whose tabs have one bot each. */
const controlledBy = (controller: BrowserController, botId: BotId): TabHolder => {
  switch (controller) {
    case "bot":
      return { _tag: "bot", botId };
    // A server from before holds a tab until it is given back.
    case "you":
      return { _tag: "you", until: null };
    case "another-device":
      return { _tag: "elsewhere" };
    case "nobody":
      return { _tag: "nobody" };
  }
};

/** A tab of every tab's list (`browser.subscribeAll`), as this device sees it. */
export const sharedViewerTab = (tab: SharedBrowserTab, here: DeviceId | null): ViewerTab => ({
  ref: tab.ref,
  url: tab.url,
  title: tab.title,
  loading: tab.loading,
  where: tab.where,
  onIt: tab.private ? [] : tab.onIt,
  acting: tab.private ? null : tab.acting,
  holder: holderOf(tab.heldBy, here),
  private: tab.private,
});

/**
 * A tab of one bot's list (`browser.subscribe`). From a server before
 * shared tabs, the bot is the tab's only one, and the only one who acts.
 */
export const botViewerTab = (tab: BrowserTab, here: DeviceId | null): ViewerTab => {
  const holder =
    tab.heldBy === undefined ? controlledBy(tab.controller, tab.botId) : holderOf(tab.heldBy, here);
  return {
    ref: tab.ref,
    url: tab.url,
    title: tab.title,
    loading: tab.loading,
    where: tab.where ?? null,
    onIt: tab.onIt ?? [tab.botId],
    acting: tab.acting ?? (holder._tag === "bot" ? holder.botId : null),
    holder,
    private: false,
  };
};

/**
 * What this device did to the page, which the server learns a moment later:
 * its own input counts from the moment it is sent.
 */
export interface PageUse {
  /** When this device last gave the page input, in epoch ms; null before any, and after Now. */
  readonly lastInputAt: number | null;
  /** The person asked the bots to wait for them, until they say Continue. */
  readonly waiting: boolean;
  /** The phone's keyboard is up on a field of the page: typing slowly is not stopping. */
  readonly keyboard: boolean;
}

export const NO_PAGE_USE: PageUse = { lastInputAt: null, waiting: false, keyboard: false };

/** How many seconds before the bots go on the line counts down. */
export const COUNTDOWN_SECONDS = 3;

/**
 * The one quiet line by a tab's address (or under its page on a phone).
 * Only the words change: nothing else on the screen moves.
 */
export type TabLine =
  /** No bot on the tab: the line is empty. */
  | { readonly _tag: "empty" }
  /** Bots on the tab, none acting now. */
  | { readonly _tag: "on-it"; readonly bots: ReadonlyArray<BotId> }
  /** `acting` acts on the page now. */
  | { readonly _tag: "acting"; readonly bots: ReadonlyArray<BotId>; readonly acting: BotId }
  /** The person here uses the page: the bots wait. */
  | { readonly _tag: "waits-for-you"; readonly bots: ReadonlyArray<BotId> }
  /** The person here stopped: the bots go on in `seconds`, which Now skips. */
  | { readonly _tag: "back-in"; readonly bots: ReadonlyArray<BotId>; readonly seconds: number }
  /** The person asked the bots to wait for them: they wait until Continue. */
  | { readonly _tag: "waits-until-continue"; readonly bots: ReadonlyArray<BotId> }
  /** The person uses the page on another device. */
  | { readonly _tag: "elsewhere"; readonly bots: ReadonlyArray<BotId> }
  /** The server types a saved login. */
  | { readonly _tag: "signing-in"; readonly bots: ReadonlyArray<BotId> };

/**
 * When the person here stops holding the tab, in epoch ms, null while they
 * hold it with no end, or `"none"` when they do not hold it. Their own input
 * counts from the moment it is sent, before the server says so.
 */
export const holdEnd = (tab: ViewerTab, use: PageUse, now: number): number | null | "none" => {
  if (tab.holder._tag === "elsewhere" || tab.holder._tag === "fill") return "none";
  if (use.waiting || use.keyboard) return null;
  const local = use.lastInputAt === null ? null : use.lastInputAt + BROWSER_PERSON_HOLD_MS;
  if (tab.holder._tag === "you") {
    // The server holds it open while nobody here said so: another of this device's views did.
    if (tab.holder.until === null) return null;
    const end = local === null ? tab.holder.until : Math.max(local, tab.holder.until);
    return end > now ? end : "none";
  }
  return local !== null && local > now ? local : "none";
};

/** The tab's line now. */
export const tabLine = (tab: ViewerTab, use: PageUse, now: number): TabLine => {
  const bots = tab.onIt;
  if (tab.holder._tag === "elsewhere") return { _tag: "elsewhere", bots };
  if (tab.holder._tag === "fill") return { _tag: "signing-in", bots };
  const end = holdEnd(tab, use, now);
  if (end !== "none" && bots.length > 0) {
    if (end === null) {
      return use.keyboard
        ? { _tag: "waits-for-you", bots }
        : { _tag: "waits-until-continue", bots };
    }
    const seconds = Math.ceil((end - now) / 1000);
    return seconds <= COUNTDOWN_SECONDS
      ? { _tag: "back-in", bots, seconds }
      : { _tag: "waits-for-you", bots };
  }
  if (bots.length === 0) return { _tag: "empty" };
  return tab.acting !== null
    ? { _tag: "acting", bots, acting: tab.acting }
    : { _tag: "on-it", bots };
};

/**
 * When the line next changes by itself, in epoch ms: a second of the
 * countdown, its start, or the hold's end. Null when only the server's
 * next word changes it.
 */
export const nextLineChange = (tab: ViewerTab, use: PageUse, now: number): number | null => {
  const end = holdEnd(tab, use, now);
  if (end === "none" || end === null) return null;
  const countdownAt = end - COUNTDOWN_SECONDS * 1000;
  if (now < countdownAt) return countdownAt;
  const left = end - now;
  return now + (left % 1000 === 0 ? 1000 : left % 1000);
};

/** How a face on a tab is lit. */
export type FaceLight =
  /** Acting on the page now: the antenna's light is on. */
  | "acting"
  /** Waiting for the person: amber. */
  | "waiting"
  | "still";

/**
 * The faces on a tab, the most recent first, with how each is lit: the
 * acting bot's light on, amber for a bot that waits for the person.
 */
export const tabFaces = (
  tab: ViewerTab,
  waitsForPerson: ReadonlySet<BotId>,
): ReadonlyArray<{ readonly botId: BotId; readonly light: FaceLight }> =>
  tab.onIt.map((botId) => ({
    botId,
    light: tab.acting === botId ? "acting" : waitsForPerson.has(botId) ? "waiting" : "still",
  }));

/**
 * The bot the live view follows on a wide page: the one of the conversation
 * the person came from while it is on the tab, else the one acting, else
 * the most recent.
 */
export const followedBot = (tab: ViewerTab, from: BotId | null): BotId | null => {
  if (from !== null && tab.onIt.includes(from)) return from;
  return tab.acting ?? tab.onIt[0] ?? null;
};

/**
 * The tab a bot's live card and the conversation's "Browsing" line show:
 * the one it acts on, else the most recent it is on, else none.
 */
export const botsTab = (tabs: ReadonlyArray<ViewerTab>, botId: BotId): ViewerTab | null =>
  tabs.find((tab) => tab.acting === botId) ??
  tabs.find((tab) => tab.onIt[0] === botId) ??
  tabs.find((tab) => tab.onIt.includes(botId)) ??
  null;

/** The tabs a viewer lists and swipes through: private tabs never, and those closing for Undo not. */
export const listedTabs = (
  tabs: ReadonlyArray<ViewerTab>,
  closing: ReadonlySet<BrowserTabRef>,
): ReadonlyArray<ViewerTab> => tabs.filter((tab) => !tab.private && !closing.has(tab.ref));

/** The tab next to `ref` toward `step` (-1 before, 1 after), or null at an end. */
export const neighborTab = (
  tabs: ReadonlyArray<ViewerTab>,
  ref: BrowserTabRef,
  step: -1 | 1,
): ViewerTab | null => {
  const at = tabs.findIndex((tab) => tab.ref === ref);
  if (at === -1) return null;
  return tabs[at + step] ?? null;
};

/**
 * The tab to show once `ref` is gone from the list: the one that took its
 * place, else the one before it, else none. `before` is the list as it was.
 */
export const tabAfterClose = (
  before: ReadonlyArray<ViewerTab>,
  after: ReadonlyArray<ViewerTab>,
  ref: BrowserTabRef,
): ViewerTab | null => {
  const at = before.findIndex((tab) => tab.ref === ref);
  const stillThere = (tab: ViewerTab | undefined) =>
    tab !== undefined && after.some((each) => each.ref === tab.ref) ? tab : null;
  return (
    stillThere(before.slice(at + 1).find((tab) => stillThere(tab) !== null)) ??
    stillThere(
      before
        .slice(0, Math.max(at, 0))
        .reverse()
        .find((tab) => stillThere(tab) !== null),
    ) ??
    after[0] ??
    null
  );
};

/**
 * The tab a live view shows, as the list changes. `fresh` is a tab the
 * person just opened, which the list may not hold yet: it is waited for.
 */
export interface ShownTab {
  readonly ref: BrowserTabRef | null;
  readonly fresh: boolean;
}

/**
 * The tab to show once the list is `after`, having shown `shown` while it
 * was `before`: the same tab while it is listed; once it is gone, the one
 * that took its place; otherwise, as the view opens, the tab of the bot the
 * person came from, else the first.
 */
export const shownTab = (input: {
  readonly shown: ShownTab;
  readonly before: ReadonlyArray<ViewerTab> | null;
  readonly after: ReadonlyArray<ViewerTab> | null;
  readonly from: BotId | null;
}): ShownTab => {
  const { shown, before, after, from } = input;
  if (after === null) return shown;
  const { ref } = shown;
  if (ref !== null && after.some((tab) => tab.ref === ref)) return { ref, fresh: false };
  if (ref !== null && shown.fresh) return shown;
  const wasListed = ref !== null && before !== null && before.some((tab) => tab.ref === ref);
  const next = wasListed
    ? tabAfterClose(before, after, ref)
    : ((from === null ? null : botsTab(after, from)) ?? after[0] ?? null);
  return { ref: next?.ref ?? null, fresh: false };
};

/** Whether a bot waiting for the person is on a tab other than `shown`: the tabs button's amber dot. */
export const needsYouElsewhere = (
  tabs: ReadonlyArray<ViewerTab>,
  shown: BrowserTabRef | null,
  waitsForPerson: ReadonlySet<BotId>,
): boolean =>
  tabs.some((tab) => tab.ref !== shown && tab.onIt.some((botId) => waitsForPerson.has(botId)));

/**
 * Why the live view's picture is frozen, if it is: the computer the tab
 * runs on went away, or this device lost its network. The bots go on by
 * themselves either way, so it says what happened and asks nothing.
 */
export type Frozen =
  | { readonly _tag: "live" }
  /** This device is offline: the bots go on on the computer. */
  | { readonly _tag: "you-offline" }
  /** The tab's computer went away; the next bot to use it opens it again on the server. */
  | { readonly _tag: "computer-away" }
  /** The view lost its socket and is opening another. */
  | { readonly _tag: "reconnecting" };

export const frozenOf = (input: {
  readonly tab: ViewerTab | null;
  readonly online: boolean;
  readonly status: "connecting" | "live" | "reconnecting" | "paused" | "ended";
}): Frozen => {
  if (!input.online) return { _tag: "you-offline" };
  if (input.tab?.where?.kind === "parked") return { _tag: "computer-away" };
  if (input.status === "reconnecting") return { _tag: "reconnecting" };
  return { _tag: "live" };
};

/** What a live view does with a tab, and whether a server from before shared tabs gave it the tab. */
export interface PageUseState {
  readonly use: PageUse;
  /** A server from before holds a tab until it is given back: whether this view took it. */
  readonly took: boolean;
}

export const NO_PAGE_USE_STATE: PageUseState = { use: NO_PAGE_USE, took: false };

/** Something the person did in a live view, or the hold of a server from before running out. */
export type PageUseEvent =
  | { readonly _tag: "input"; readonly input: BrowserInput }
  /** Now, during the countdown, and Continue, after Wait for me: the bots go on at once. */
  | { readonly _tag: "give-back" }
  | { readonly _tag: "wait-for-me" }
  | { readonly _tag: "keyboard"; readonly up: boolean }
  /** The person left the live view. */
  | { readonly _tag: "leave" }
  /** The hold ended here, which a server from before does not know by itself. */
  | { readonly _tag: "hold-ended" };

/** Whether `input` uses the page, which holds the tab, rather than only pointing at it or asking. */
export const usesPage = (input: BrowserInput): boolean => {
  switch (input.type) {
    case "pointer":
      return input.action !== "move";
    case "probe":
    case "take":
    case "release":
      return false;
    case "wheel":
    case "key":
    case "text":
    case "navigate":
    case "back":
    case "forward":
    case "reload":
    case "dialog":
      return true;
  }
};

/**
 * What one event does: the next state, and the frames to send for it, in
 * order. On a server that shares its tabs (`shared`), using the page is
 * taking it and the server ends the hold; on one from before, the view takes
 * the tab before its first input and gives it back once the hold ends here,
 * so the person sees the same either way.
 */
export const pageUseStep = (
  state: PageUseState,
  event: PageUseEvent,
  shared: boolean,
  at: number,
): { readonly state: PageUseState; readonly send: ReadonlyArray<BrowserInput> } => {
  const { use, took } = state;
  switch (event._tag) {
    case "input": {
      if (!usesPage(event.input)) return { state, send: [event.input] };
      const takeFirst = !shared && !took;
      return {
        state: { use: { ...use, lastInputAt: at }, took: took || takeFirst },
        send: takeFirst ? [{ type: "take" }, event.input] : [event.input],
      };
    }
    case "give-back":
      return { state: NO_PAGE_USE_STATE, send: [{ type: "release" }] };
    case "wait-for-me":
      return { state: { use: { ...use, waiting: true }, took: true }, send: [{ type: "take" }] };
    case "keyboard": {
      if (use.keyboard === event.up) return { state, send: [] };
      if (event.up) {
        // Typing slowly is not stopping: the tab stays held while the keyboard is up.
        return {
          state: { use: { ...use, keyboard: true }, took: true },
          send: use.waiting ? [] : [{ type: "take" }],
        };
      }
      // Going down starts the usual hold, unless the person asked the bots to wait.
      return {
        state: { use: { ...use, keyboard: false, lastInputAt: at }, took },
        send: use.waiting || !shared ? [] : [{ type: "release", idle: true }],
      };
    }
    case "leave": {
      const held = took || use.lastInputAt !== null || use.waiting || use.keyboard;
      return { state: NO_PAGE_USE_STATE, send: held ? [{ type: "release" }] : [] };
    }
    case "hold-ended":
      return { state: { use, took: false }, send: !shared && took ? [{ type: "release" }] : [] };
  }
};
