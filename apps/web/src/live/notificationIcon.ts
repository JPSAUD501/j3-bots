// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A notification's icon: the still avatar of what it is about, drawn as a PNG,
 * since browsers take no SVG there. The rasterizer is not part of the app's
 * start: `loadRasterizer` fetches it once the app has started, so a page left
 * open across a server upgrade, whose old build's files are gone, already
 * holds it when a notification arrives.
 */
import type { BotId, Notification, RosterItem } from "@j3-bots/contracts";
import { notificationLook } from "@j3-bots/client-runtime/presentation";
import type { Themed } from "@j3-bots/design-tokens";

/** The app's icon, for a notification whose avatar cannot be drawn. */
const APP_ICON = "/icon-192.png";

/**
 * The icon's side, in px. Chrome draws a notification's icon in an 80 px
 * square (`kNotificationIconSize`, in Chromium's message center), and the
 * systems that show it themselves give it about as much or less, so 192 px
 * stays sharp up to about two and a half device pixels per px there, and on
 * phones, whose slot is smaller. No slot is as small as 28 px, below which an
 * avatar draws its mark larger: the proportions drawn for 192 px are the ones
 * the slot needs.
 */
const ICON_SIZE = 192;

/** The theme the system is in now, which is the one it draws its notifications in. */
export const systemTheme = (): keyof Themed =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

let rasterizer: Promise<typeof import("@j3-bots/design-tokens/raster") | null> | undefined;

/**
 * The rasterizer, fetched once. A page that has started and shows
 * notifications calls this then, before any notification; a failed fetch
 * leaves the app's icon in its place.
 */
export const loadRasterizer = () =>
  (rasterizer ??= import("@j3-bots/design-tokens/raster").catch(() => null));

const dataUrl = (png: Uint8Array) => {
  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
};

/**
 * The icon of `notification`, in `theme`, as a URL the browser can show. A
 * bot's conversation shows the bot that wrote, in the look the notification
 * gives it (`notificationLook`); a room shows its first two members'
 * shapes, as the roster does. The app's icon stands in when there is no
 * avatar to draw, as for a room whose members are all gone from the roster,
 * or when the rasterizer could not be fetched.
 */
export async function notificationIcon(
  notification: Notification,
  roster: ReadonlyArray<RosterItem>,
  theme: keyof Themed,
): Promise<string> {
  const bots = roster.flatMap((row) => (row._tag === "bot" ? [row.bot] : []));
  const bot = (id: BotId) => bots.find((candidate) => candidate.id === id);
  const { target } = notification;
  const draw = await loadRasterizer();
  if (draw === null) return APP_ICON;
  if (target._tag === "conversation") {
    const writer = bot(notification.botId);
    if (writer === undefined) return APP_ICON;
    const look = notificationLook(notification, writer.state);
    return dataUrl(draw.renderStillAvatar(writer.profile.avatar, look, theme, ICON_SIZE));
  }
  const room = roster.flatMap((row) =>
    row._tag === "room" && row.room.id === target.roomId ? [row.room] : [],
  )[0];
  const members = (room?.members ?? []).flatMap((id) => bot(id)?.profile.avatar ?? []);
  if (members.length === 0) return APP_ICON;
  return dataUrl(draw.renderStillRoomAvatar(members, theme, ICON_SIZE));
}
