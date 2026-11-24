// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserInput } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { EngineUnavailable } from "./errors.ts";
import type { EngineTabId, SessionId } from "./ids.ts";

/** A tab a bot opened in the engine's browser. */
export interface EngineBrowserTab {
  readonly id: EngineTabId;
  /** The session whose bot opened it, directly or as a page's pop-up. */
  readonly sessionId: SessionId;
  /** Empty until the tab loads a page. */
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  /** When it last opened or navigated, in epoch milliseconds: the newest is the bot's front tab. */
  readonly activeAt: number;
}

/**
 * The page a tab shows, as the engine reports it when asked: nothing yet, a
 * page still loading, the page it committed to, or one that failed to load.
 * `url` is the tab's top-level address; the engine knows nothing of frames.
 */
export type TabPage =
  | { readonly _tag: "blank" }
  | { readonly _tag: "loading"; readonly url: string }
  | { readonly _tag: "loaded"; readonly url: string }
  | { readonly _tag: "failed"; readonly url: string };

/**
 * Who acts on a viewer's tab, from that viewer's point of view: the bot that
 * opened it, this viewer, another viewer, or nobody.
 */
export type ViewerController = "bot" | "this-viewer" | "another-viewer" | "nobody";

/** What a viewer receives, decoded. Anything else the engine sends is dropped. */
export type ViewerOutput =
  /** One picture of the page. The next comes only after `ack`. */
  | { readonly _tag: "frame"; readonly jpeg: Uint8Array }
  /** The page's size in CSS pixels, the space input coordinates are in. */
  | { readonly _tag: "viewport"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "control";
      readonly controller: ViewerController;
      readonly generation: number;
      readonly dialog: {
        readonly kind: "alert" | "confirm" | "prompt" | "beforeunload";
        readonly message: string;
        readonly defaultValue: string;
      } | null;
    }
  | { readonly _tag: "probe"; readonly x: number; readonly y: number; readonly editable: boolean }
  /** Where the bot points while it acts on the tab, and when it clicks. */
  | {
      readonly _tag: "cursor";
      readonly action: "move" | "click";
      readonly x: number;
      readonly y: number;
    };

/**
 * Why a viewer's output ended: the tab closed or never existed (`gone`), the
 * host needs setting up before the browser can start (`setup-needed`), the
 * engine asked its viewers to connect again (`reconnect`), or the connection
 * was lost (`lost`).
 */
export class ViewerClosed extends Schema.TaggedError<ViewerClosed>()("ViewerClosed", {
  reason: Schema.Literals(["gone", "setup-needed", "reconnect", "lost"]),
  /** For `setup-needed`: what the host lacks. */
  need: Schema.optionalKey(Schema.Literals(["sandbox", "libraries"])),
}) {
  override get message(): string {
    return `The browser viewer closed: ${this.reason}.`;
  }
}

/** One connection watching one tab, and, once it takes control, acting on it. */
export interface BrowserViewer {
  /** Ends with `ViewerClosed` once the connection does; never ends otherwise. */
  readonly output: Stream.Stream<ViewerOutput, ViewerClosed>;
  /**
   * Says the last picture was used, so the engine sends the next. Each
   * `frame` is acknowledged once: until then the engine sends no other.
   */
  readonly ack: Effect.Effect<void>;
  /**
   * Passes input to the tab. The engine applies page input only from the
   * viewer that holds the tab, and drops the rest; `take` fails, changing
   * nothing, while another viewer holds it, which the next `control` says.
   */
  readonly send: (input: BrowserInput) => Effect.Effect<void>;
}

/**
 * The engine's browser, in J3 Bots terms: the tabs bots open, and viewers of
 * them. Every viewer is a connection of its own, so the engine keeps track
 * of which one holds a tab; a viewer that closes gives its tab back.
 */
export class BrowserBridge extends Context.Service<
  BrowserBridge,
  {
    /**
     * Every tab bots have open, then the whole list again on every change.
     * `sessions` is read each time the adapter has to list tabs afresh, at
     * the start and after the engine restarts or its connection drops: it
     * names the sessions whose tabs to look for, and a session opened later
     * is found by its tabs' own events. Never fails: while the engine is not
     * ready the list is empty.
     */
    readonly tabs: (
      sessions: Effect.Effect<ReadonlyArray<SessionId>>,
    ) => Stream.Stream<ReadonlyArray<EngineBrowserTab>>;
    /**
     * A viewer of `tab`, for as long as the scope lives. Pictures are at most
     * `maxWidth` by `maxHeight` device pixels, at JPEG `quality`.
     * `EngineUnavailable`: the engine is not ready, and nothing was opened.
     * A tab that is gone opens a viewer whose output ends at once.
     */
    /**
     * The page `tab` shows now, read from the engine at the call rather than
     * from the followed list, which lags behind it. None when the tab is gone.
     * `EngineUnavailable`: the engine did not answer, and nothing is known.
     */
    readonly readTab: (
      tab: EngineTabId,
    ) => Effect.Effect<Option.Option<TabPage>, EngineUnavailable>;
    readonly openViewer: (input: {
      readonly tab: EngineTabId;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
    }) => Effect.Effect<BrowserViewer, EngineUnavailable, Scope.Scope>;
  }
>()("@j3-bots/engine-t3/Browser/BrowserBridge") {}
