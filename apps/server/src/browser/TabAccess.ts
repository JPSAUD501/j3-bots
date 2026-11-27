// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, BrowserPageState, BrowserTabRef, SharedBrowserTab } from "@j3-bots/contracts";
import type { PageHost } from "@j3-bots/browser";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

// What the login fill and browser help need of J3 Bots' shared tabs
// (decision 0110; `docs/architecture/server.md`, "Filling a login" and
// "Help in the browser"). The Browser service, which keeps the tabs, their
// leases and the person's hold, provides it. Nothing here knows a host's
// kind: a tab may run on a desktop or on the server's own browser.

/**
 * Why the server could not hold a tab to type a saved login.
 *
 * - `no-tab`: the tab is gone, or parked: a parked tab has no page to type
 *   into, and is not reopened for a fill.
 * - `held`: a person holds the tab.
 * - `unavailable`: its host did not answer, or the tab's lease did not come
 *   free in time.
 */
export class FillHoldRefused extends Schema.TaggedError<FillHoldRefused>()("FillHoldRefused", {
  reason: Schema.Literals(["no-tab", "held", "unavailable"]),
}) {}

/** A tab the server holds to type a saved login, for as long as the hold's scope lives. */
export interface FillHold {
  /** The host the tab runs on now, for `tab.fill`. */
  readonly host: PageHost;
  /** The tab's page as its host last reported it, once the hold was taken. */
  readonly page: BrowserPageState;
  /** Whether a person's input took the tab since the hold began. */
  readonly preempted: Effect.Effect<boolean>;
}

/** A tab a person holds now: their input, or their "wait for me". */
export interface PersonHold {
  readonly tab: BrowserTabRef;
  /** The bots on the tab when the person took it, the most recent first. */
  readonly onIt: ReadonlyArray<BotId>;
}

export class TabAccess extends Context.Service<
  TabAccess,
  {
    /**
     * The tab a bot's tool call works on: `tab` when it names one, otherwise
     * the bot's current tab, as for the `browser_*` tools. None when there is
     * no such tab. A private tab is never one.
     */
    readonly toolTab: (
      botId: BotId,
      tab: BrowserTabRef | undefined,
    ) => Effect.Effect<Option.Option<SharedBrowserTab>>;
    /**
     * Holds `tab` as the server's fill (`BrowserTabHolder` `fill`) until the
     * scope closes, which releases it. It waits only for a bot's action that
     * runs now, and goes before bots that queue. A person's input still takes
     * the tab at once; `preempted` then says so.
     */
    readonly holdForFill: (
      tab: BrowserTabRef,
    ) => Effect.Effect<FillHold, FillHoldRefused, Scope.Scope>;
    /** Every tab open or parked, now and on every change. */
    readonly present: Stream.Stream<ReadonlySet<BrowserTabRef>>;
    /** Every tab a person holds, now and on every change. */
    readonly personHolds: Stream.Stream<ReadonlyArray<PersonHold>>;
    /** Ends the person's hold on `tab` at once, as a help card's Done does. */
    readonly endPersonHold: (tab: BrowserTabRef) => Effect.Effect<void>;
  }
>()("@j3-bots/server/browser/TabAccess") {}
