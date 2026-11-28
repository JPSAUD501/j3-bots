// SPDX-License-Identifier: AGPL-3.0-or-later
// Painting a hidden tab while it is watched or driven follows T3 Code v0.1.13,
// apps/desktop/src/preview/DesktopBrowserHost.ts (`setFocusEmulation`, MIT License,
// Copyright (c) 2026 T3 Tools Inc.; see apps/desktop/NOTICE), as phase 0 measured it:
// focus emulation and background throttling off, only for as long as it is needed.
import { type DriverPage, makeDriverPage } from "@j3-bots/browser";
import { BrowserHostError, type BrowserTabRef } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { WebContents, WebContentsView } from "electron";
import { makeInputHold } from "./hold.ts";
import type { Identity } from "./identity.ts";
import { pageMayGo } from "./policy.ts";
import { relayPage } from "./relay.ts";

/** A protocol version the debugger of Electron 44's Chromium speaks. */
const DEBUGGER_PROTOCOL = "1.3";

/**
 * Commands that are a bot's hands on the page, sent through the relay. A
 * person's input from a viewer goes the same way: the server knows of it.
 */
const DRIVING = /^(?:Input\.|Page\.navigate$|Runtime\.(?:evaluate|callFunctionOn)$)/;

/** How long after a bot's input a download it began is still the bot's. */
const BOT_DOWNLOAD_WINDOW_MS = 5_000;

/** The kinds of the view's own input that are the person using the page. */
const USING = new Set(["mouseDown", "keyDown", "rawKeyDown", "char", "touchStart", "gestureTap"]);

/** One tab of the desktop's browser: its view, its page, and its driver. */
export interface DesktopTab {
  readonly ref: BrowserTabRef;
  readonly private: boolean;
  readonly view: WebContentsView;
  readonly contents: WebContents;
  readonly driver: DriverPage;
  /** Keeps the page painting, shown or hidden, for as long as the scope lives. */
  readonly paint: Effect.Effect<void, never, Scope.Scope>;
  /** Keeps the page painting while `effect` runs. */
  readonly painting: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Scope.Scope>>;
  /**
   * Drops the person's keys and mouse on the page while `effect` runs: a bot
   * is typing a saved login into it. The debugger's key events pass, as the
   * view's own input hooks never see them, but its mouse events would not
   * (verified on Electron 44): a fill uses none.
   */
  readonly holding: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Whether a download that begins now is the bot's: one of its actions ran just before. */
  readonly botLed: () => boolean;
  /** The person used the tab from the app: its address bar, back, reload. */
  readonly personUsed: () => void;
}

export interface DesktopTabEvents {
  /** The person used the page in the view: a click, a key, a touch. */
  readonly personInput: () => void;
}

const failed = (detail: string) =>
  new BrowserHostError({ reason: "page", detail: detail.slice(0, 500) });

/** Resolves once `contents` has finished its first load, or failed it. */
const settled = (contents: WebContents) =>
  Effect.callback<void>((resume) => {
    if (!contents.isLoadingMainFrame() && contents.getURL() !== "") {
      resume(Effect.void);
      return;
    }
    const done = () => resume(Effect.void);
    contents.once("did-stop-loading", done);
    return Effect.sync(() => contents.off("did-stop-loading", done));
  });

/**
 * Takes `view`'s page as the tab `ref` for as long as the scope lives:
 * keeps it on the schemes a tab may show, and once its first load ends
 * attaches its debugger, gives it the browser's identity and connects the
 * driver. A view of its own loads a blank page here; a pop-up's first
 * page, which its opener is loading, is waited for, and shows the
 * session's identity alone.
 */
export const takeTab = (options: {
  readonly ref: BrowserTabRef;
  readonly private: boolean;
  readonly view: WebContentsView;
  readonly identity: Identity;
  readonly adopted: boolean;
  readonly events: DesktopTabEvents;
}): Effect.Effect<DesktopTab, BrowserHostError, Scope.Scope> =>
  Effect.gen(function* () {
    const { view, identity, events } = options;
    const contents = view.webContents;

    const guard = (event: { readonly url: string; preventDefault: () => void }) => {
      if (!pageMayGo(event.url)) event.preventDefault();
    };
    contents.on("will-navigate", guard);
    contents.on("will-frame-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-attach-webview", (event) => event.preventDefault());

    const holding = makeInputHold((drop) => {
      contents.on("before-input-event", drop);
      contents.on("before-mouse-event", drop);
    });

    // Whose input reaches the view: the bot's, through the debugger, or the person's.
    let driving = 0;
    let botAt = Number.NEGATIVE_INFINITY;
    let personAt = Number.NEGATIVE_INFINITY;
    contents.on("input-event", (_event, input) => {
      if (driving > 0 || !USING.has(input.type)) return;
      personAt = performance.now();
      events.personInput();
    });

    // A tab of its own loads its blank page first; a pop-up, the address its opener gave.
    if (!options.adopted) {
      yield* Effect.tryPromise({
        try: () => contents.loadURL("about:blank"),
        catch: (cause) => failed(`The tab did not open: ${String(cause)}`),
      });
    }
    yield* settled(contents);
    // Attached only now: a debugger attached before a view's first load
    // leaves it drawing no frames at all (verified on Electron 44).
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (!contents.debugger.isAttached()) contents.debugger.attach(DEBUGGER_PROTOCOL);
        },
        catch: (cause) => failed(`The page's debugger did not attach: ${String(cause)}`),
      }),
      // Let go before the app quits: a debugger left attached can hold the process up.
      () =>
        Effect.sync(() => {
          if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
        }),
    );
    // The page's script sees the same Chrome the request headers name.
    yield* Effect.tryPromise({
      try: () =>
        contents.debugger.sendCommand("Emulation.setUserAgentOverride", {
          userAgent: identity.userAgent,
          platform: identity.navigatorPlatform,
          userAgentMetadata: identity.metadata,
        }),
      catch: (cause) => failed(`The page's identity was not set: ${String(cause)}`),
    });
    const relayed = yield* relayPage(contents, {
      sent: (method, reply) => {
        if (!DRIVING.test(method)) return;
        botAt = performance.now();
        driving += 1;
        const done = () => {
          driving -= 1;
        };
        reply.then(done, done);
      },
    }).pipe(Effect.mapError((error) => failed(error.detail)));
    const driver = yield* makeDriverPage({
      tab: options.ref,
      page: relayed.page,
      cdp: relayed.cdp,
    });

    let painters = 0;
    // Not awaited: a page held by a dialog answers no command until the
    // dialog closes, and an action that opened one must still end.
    const paintOn = (on: boolean) =>
      Effect.sync(() => {
        if (contents.isDestroyed()) return;
        contents.setBackgroundThrottling(!on);
        contents.debugger
          .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: on })
          .catch(() => undefined);
      });
    const paint = Effect.acquireRelease(
      Effect.suspend(() => (++painters === 1 ? paintOn(true) : Effect.void)),
      () => Effect.suspend(() => (--painters === 0 ? paintOn(false) : Effect.void)),
    );
    const painting = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(Effect.andThen(paint, effect));

    return {
      ref: options.ref,
      private: options.private,
      view,
      contents,
      driver,
      paint,
      painting,
      holding,
      botLed: () => {
        const now = performance.now();
        return now - botAt <= BOT_DOWNLOAD_WINDOW_MS && botAt > personAt;
      },
      personUsed: () => {
        personAt = performance.now();
      },
    };
  });
