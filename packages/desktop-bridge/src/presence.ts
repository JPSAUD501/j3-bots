// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, BrowserTabRef, Profile } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// Who is on the desktop browser's tabs, for the page itself to draw their
// pointers (docs/architecture/browser.md, "Presence in the page"). The main
// window's page knows it from the server and tells the main process, which
// draws it in the tab's page, in a world of its own the page cannot reach.
// Apart from the rest of the bridge, so the page's drawing carries only this.

/** A bot on a tab, as its pointer shows it: its face and name, and whether it thinks before it acts. */
export const PresenceBot = Schema.Struct({
  id: BotId,
  profile: Schema.Struct({ name: Profile.fields.name, avatar: Profile.fields.avatar }),
  thinking: Schema.Boolean,
});
export type PresenceBot = typeof PresenceBot.Type;

const Bots = Schema.Array(PresenceBot).check(Schema.isMaxLength(64));

/** A tab's bots, most recent first, and whether the person holds the tab. */
export const TabPresence = Schema.Struct({
  tab: BrowserTabRef,
  bots: Bots,
  held: Schema.Boolean,
});
export type TabPresence = typeof TabPresence.Type;

/** Every tab with a bot on it, from the main window's page each time that changes. */
export const BrowserPresence = Schema.Array(TabPresence).check(Schema.isMaxLength(500));
export type BrowserPresence = typeof BrowserPresence.Type;

/**
 * What the main process asks of the drawing in a tab's page. `draw`: the
 * tab's bots now; `hidden` while the page is captured for a bot, which
 * reads the page and never its own pointer. `point`: where the tab's bot
 * points now, in the page's CSS pixels; `sequence` grows with each, so a
 * second click on the same point is told apart.
 */
export const PresenceCall = Schema.Union([
  Schema.TaggedStruct("draw", { bots: Bots, held: Schema.Boolean, hidden: Schema.Boolean }),
  Schema.TaggedStruct("point", {
    action: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
    sequence: Schema.Int,
  }),
]);
export type PresenceCall = typeof PresenceCall.Type;

/** The global the drawing defines in its world, which each call goes to. */
export const PRESENCE_GLOBAL = "j3Presence";
