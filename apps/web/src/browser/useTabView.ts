// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewHandle, BrowserViewState } from "@j3-bots/client-runtime";
import type { BrowserTabRef } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState, useSyncExternalStore, type RefCallback } from "react";
import { useBrowser } from "./context";
import { viewLockName } from "./kept";
import { emptyStore, heldStore } from "./held";
import { type LinkHint, sizeChanged, type Size, viewQuality, viewSize } from "./input";
import { holdLock } from "./locks";
import { holds } from "./source";

/** How long the drawn size stays put before the picture is asked for at it. */
const RESIZE_SETTLE = 500;

const decodeLinkHint = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optionalKey(Schema.String),
    effectiveType: Schema.optionalKey(Schema.String),
    saveData: Schema.optionalKey(Schema.Boolean),
  }),
);

/** What the browser says of its link, where it implements the Network Information API. */
export const linkHint = (): LinkHint | null => {
  if (!("connection" in navigator)) return null;
  const hint = decodeLinkHint(navigator.connection);
  return hint._tag === "Some" ? hint.value : null;
};

/** One view of the tab the viewer shows, as it stands. */
export interface TabView {
  readonly view: BrowserViewHandle;
  readonly state: BrowserViewState;
  /** The operator gave the tab back: leaving closes the view instead of keeping it. */
  readonly releasing: () => void;
  /** Opens the view again, as after it failed or another window took the tab. */
  readonly reopen: () => void;
}

type Asked = { readonly maxWidth: number; readonly maxHeight: number };

const sameSize = (box: Size): Size => box;

/**
 * A picture for a view that zooms, as the narrow web's live view: as large
 * as the stage's longer side both ways, so a page zoomed to read stays sharp.
 */
export const zoomableSize = (box: Size): Size => {
  const side = Math.max(box.width, box.height);
  return { width: side, height: side };
};

/**
 * Holds a view of `shownTab`, a media socket with the picture asked for at the
 * size the stage `stageRef` is put on is drawn, opened again once that size
 * changes for good. Each socket asks for the quality the link allows as it
 * opens. A view of a tab this device holds is handed to the provider when the
 * viewer moves on, so the tab stays the operator's; the next view this device
 * opens of it takes the tab over, control included.
 */
export function useTabView(
  shownTab: BrowserTabRef | null,
  /** The size to ask the picture for, from the stage's: the stage's own unless given. */
  sizeFor: (box: Size) => Size = sameSize,
): {
  readonly stageRef: RefCallback<HTMLElement>;
  /** The stage's size; null until measured. */
  readonly box: Size | null;
  /** Null until the stage is measured, and with no tab. */
  readonly current: TabView | null;
} {
  const { source, kept } = useBrowser();
  const [box, setBox] = useState<Size | null>(null);
  // The size asked for, which changes only once the drawn size settles and differs enough.
  const [asked, setAsked] = useState<Asked | null>(null);
  const stageRef = useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return;
      let settled: Asked | null = null;
      let timer: number | undefined;
      const ask = (next: Asked) => {
        settled = next;
        setAsked(next);
      };
      const observer = new ResizeObserver(([entry]) => {
        if (entry === undefined) return;
        const { width, height } = entry.contentRect;
        setBox({ width, height });
        const next = viewSize(sizeFor({ width, height }), window.devicePixelRatio);
        window.clearTimeout(timer);
        if (settled === null) ask(next);
        else if (sizeChanged(settled, next))
          timer = window.setTimeout(() => ask(next), RESIZE_SETTLE);
      });
      observer.observe(element);
      return () => {
        window.clearTimeout(timer);
        observer.disconnect();
      };
    },
    [sizeFor],
  );

  const store = useMemo(
    () =>
      shownTab === null || asked === null
        ? emptyStore<TabView | null>(null)
        : tabViewStore({ source, kept }, shownTab, asked),
    [source, kept, shownTab, asked],
  );
  const current = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { stageRef, box, current };
}

/**
 * A view of `tab` while the store has a subscriber: a socket asking for
 * pictures at `asked`, kept for the tab's sake when the operator holds it.
 */
const tabViewStore = (
  { source, kept }: ReturnType<typeof useBrowser>,
  tab: BrowserTabRef,
  asked: Asked,
) =>
  heldStore<TabView | null>((notify) => {
    let released = false;
    let stop = () => {};
    // Null until every still of the tab has stopped, so this view's socket is the tab's last.
    let snapshot: TabView | null = null;
    // Whether this device held the tab at the last change: taking it again undoes a giving back.
    let yours = false;
    const start = () => {
      const view = source.openBrowserView({
        ref: tab,
        size: () => ({ ...asked, quality: viewQuality(linkHint()) }),
      });
      released = false;
      const opened: TabView = {
        view,
        state: view.state.get(),
        releasing: () => {
          released = true;
        },
        reopen: () => {
          stop();
          view.close();
          start();
          notify();
        },
      };
      snapshot = opened;
      stop = view.state.subscribe(() => {
        const state = view.state.get();
        const now = state.control?.controller === "you";
        if (now && !yours) released = false;
        yours = now;
        snapshot = { ...opened, state };
        notify();
      });
    };
    const unlock = holdLock(viewLockName(tab), () => {
      kept.makeWay(tab);
      start();
      notify();
    });
    return {
      get: () => snapshot,
      close: () => {
        stop();
        if (snapshot !== null) {
          const { view } = snapshot;
          if (holds(view.state.get()) && !released) kept.keep(tab, view);
          else view.close();
        }
        unlock();
      },
    };
  }, null);
