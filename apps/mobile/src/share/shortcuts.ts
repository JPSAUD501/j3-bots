// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { appLink, appScheme } from "../links.ts";
import { iconFace } from "../platform/faceImages.ts";
import type { Session } from "../session.ts";
import { shownPalettes, subscribeLook } from "../themes/look.ts";
import { lastSharedTo } from "./lastShared.ts";
import { type ShortcutBot, shareSheet } from "./native.ts";
import { shareBots } from "./order.ts";

// Direct Share: the bots Android offers at the top of its share menu, each
// opening the share sheet with that bot picked. They follow the roster and
// the theme while the app runs, in the share sheet's order, and go when the
// phone is no longer paired.

/** An icon's side in px: Android's largest launcher icon, 108 dp at four pixels per dp. */
const ICON_SIZE = 432;

/** How long the roster settles before the shortcuts are set, in ms. */
const SETTLE = 1000;

/** The shortcuts the roster of `client` makes now; null while it is loading. */
const shortcutsOf = (client: J3Client, scheme: string): ReadonlyArray<ShortcutBot> | null => {
  const roster = client.roster.get();
  if (roster._tag !== "ready") return null;
  const plate = shownPalettes().light.muted;
  return shareBots(roster.value, lastSharedTo()).map((item) => ({
    id: item.bot.id,
    name: item.bot.profile.name,
    icon: iconFace(item.bot.profile.avatar, item.bot.id, plate, ICON_SIZE),
    link: appLink(scheme, { _tag: "bot", botId: item.bot.id }),
  }));
};

/** What tells one set of shortcuts from another: the bots, their names and their looks. */
const keyOf = (bots: ReadonlyArray<ShortcutBot>) =>
  JSON.stringify(bots.map(({ id, name, icon }) => [id, name, icon]));

/** Keeps Direct Share's bots in step with the roster while the app runs. Android only. */
export const keepShareTargets = (session: Session): void => {
  const scheme = appScheme();
  if (shareSheet === null || scheme === null) return;
  const sheet = shareSheet;
  let set: string | null = null;
  const apply = (bots: ReadonlyArray<ShortcutBot>) => {
    const key = keyOf(bots);
    if (key === set) return;
    set = key;
    sheet.setShortcuts(bots).catch(() => {
      set = null;
    });
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let followed: { readonly client: J3Client; readonly stop: () => void } | null = null;
  const follow = () => {
    const state = session.state.get();
    if (state._tag === "starting") return;
    const client =
      state._tag === "open" && state.client.connection.get()._tag !== "unpaired"
        ? state.client
        : null;
    if (followed?.client === client) return;
    followed?.stop();
    followed = null;
    if (client === null) {
      apply([]);
      return;
    }
    const update = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const bots = shortcutsOf(client, scheme);
        if (bots !== null) apply(bots);
      }, SETTLE);
    };
    // Their icons sit on the theme's colors.
    const stopRoster = client.roster.subscribe(update);
    const stopLook = subscribeLook(update);
    followed = {
      client,
      stop: () => {
        stopRoster();
        stopLook();
        if (timer !== null) clearTimeout(timer);
      },
    };
    update();
  };

  let watched: (() => void) | null = null;
  const watch = () => {
    watched?.();
    const state = session.state.get();
    watched = state._tag === "open" ? state.client.connection.subscribe(follow) : null;
    follow();
  };
  session.state.subscribe(watch);
  watch();
};
