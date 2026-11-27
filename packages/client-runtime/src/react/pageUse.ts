// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- a React hook, which runs on the platform's timers, outside any Effect program.
// @effect-diagnostics globalDate:off -- a hold ends at a wall-clock time the server gives it.
import type { BrowserInput } from "@j3-bots/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  holdEnd,
  nextLineChange,
  NO_PAGE_USE_STATE,
  type PageUseEvent,
  type PageUseState,
  pageUseStep,
  type TabLine,
  tabLine,
  type ViewerTab,
} from "../presentation/browserTabs.ts";

/** What a live view does with a tab: the person uses its page, and the bots wait for them. */
export interface PageUseHandle {
  /** The tab's line now, kept current through the countdown. */
  readonly line: TabLine;
  /** This device holds the tab: the bots' pointers step aside. */
  readonly holding: boolean;
  /** Whether the phone's keyboard is up on a field of the page, as `keyboard` last said. */
  readonly keyboardUp: boolean;
  /** Sends what the person did. Input to the page itself holds the tab; moving the pointer does not. */
  readonly send: (input: BrowserInput) => void;
  /** Now, during the countdown, and Continue, after Wait for me: the bots go on at once. */
  readonly giveBack: () => void;
  /** Wait for me: the bots on the tab wait until Continue. */
  readonly waitForMe: () => void;
  /** The phone's keyboard rose on a field of the page, or went down. */
  readonly keyboard: (up: boolean) => void;
  /** The person leaves the live view: what this device held goes back to the bots at once. */
  readonly leave: () => void;
}

/** The person's use of one tab through a live view; see `pageUseStep`. */
export const usePageUse = (input: {
  readonly tab: ViewerTab | null;
  /** The view's own `send`, or null while there is no view. */
  readonly send: ((input: BrowserInput) => void) | null;
  /** The server shares its tabs (`sharedBrowser`). */
  readonly shared: boolean;
}): PageUseHandle => {
  const { tab, send, shared } = input;
  const [state, setState] = useState<PageUseState>(NO_PAGE_USE_STATE);
  const [now, setNow] = useState(() => Date.now());
  // The newest state and `send`, for the handlers, which stay the same across renders.
  const latest = useRef({ state, send, shared });
  useEffect(() => {
    latest.current = { state, send, shared };
  });

  const dispatch = useCallback((event: PageUseEvent) => {
    const at = Date.now();
    const { state: current, send: write, shared: on } = latest.current;
    const next = pageUseStep(current, event, on, at);
    latest.current = { ...latest.current, state: next.state };
    for (const frame of next.send) write?.(frame);
    setState(next.state);
    setNow(at);
  }, []);

  // The line changes by itself only at the countdown's seconds and the hold's end.
  const at = tab === null ? null : nextLineChange(tab, state.use, now);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(at - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [at]);

  const holding = tab !== null && holdEnd(tab, state.use, now) !== "none";
  // A server from before keeps the tab until it is given back: give it back as the hold ends,
  // and give back a tab it still says this device took, as one taken before the app restarted.
  const ended = !shared && !holding && (state.took || tab?.holder._tag === "taken");
  useEffect(() => {
    if (ended) dispatch({ _tag: "hold-ended" });
  }, [ended, dispatch]);

  return {
    line: tab === null ? { _tag: "empty" } : tabLine(tab, state.use, now),
    holding,
    keyboardUp: state.use.keyboard,
    send: useCallback(
      (frame: BrowserInput) => dispatch({ _tag: "input", input: frame }),
      [dispatch],
    ),
    giveBack: useCallback(() => dispatch({ _tag: "give-back" }), [dispatch]),
    waitForMe: useCallback(() => dispatch({ _tag: "wait-for-me" }), [dispatch]),
    keyboard: useCallback((up: boolean) => dispatch({ _tag: "keyboard", up }), [dispatch]),
    leave: useCallback(() => dispatch({ _tag: "leave" }), [dispatch]),
  };
};
