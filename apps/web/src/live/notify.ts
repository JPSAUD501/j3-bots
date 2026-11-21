// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId, EntryTarget } from "@j3-bots/contracts";
import type { NotificationText } from "@j3-bots/i18n";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NOTIFICATION_CLICK } from "../../pwa/notificationClick";

/** A click on a notification: what it was about, and the pairing that received it. */
interface NotificationClick {
  readonly target: EntryTarget;
  readonly pairing: DeviceId;
}

interface ShownNotification extends NotificationText, NotificationClick {
  /**
   * One per entry: every window of the browser shows the notifications the
   * server sends, and the browser keeps one notification per tag.
   */
  readonly tag: string;
  /** The icon's URL: the still avatar of what it is about (`notificationIcon`). */
  readonly icon: string;
}

/**
 * The service worker that keeps the installed app, once it is active.
 * Development has none, and neither does a page outside a secure context.
 */
async function activeServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.active ? registration : null;
}

/** Notifications this page showed itself, where there is no service worker. */
const shownByPage = new Set<{ readonly notification: Notification; readonly pairing: DeviceId }>();

const handlers = new Set<(click: NotificationClick) => void>();
/** A click no window handled yet, as in a window opened for it that is still starting. */
let pending: NotificationClick | null = null;

function clicked(click: NotificationClick) {
  if (handlers.size === 0) {
    pending = click;
    return;
  }
  for (const handle of handlers) handle(click);
}

const decodePairing = Schema.decodeUnknownOption(Schema.Struct({ pairing: DeviceId }));

/** A notification the browser shows: what it carries, and how it leaves the screen. */
type Shown = Pick<Notification, "data" | "close">;

/** Whether `notification` was received under `pairing`, as its data says. */
const receivedUnder = (notification: Shown, pairing: DeviceId) => {
  const from = decodePairing(notification.data);
  return Option.isSome(from) && from.value.pairing === pairing;
};

/**
 * Closes those of `notifications` received under `pairing`, and only those:
 * one another pairing received, or that names none, stays.
 */
export function closeReceivedUnder(notifications: Iterable<Shown>, pairing: DeviceId): void {
  for (const notification of notifications) {
    if (receivedUnder(notification, pairing)) notification.close();
  }
}

/**
 * Closes those of `notifications` received under a pairing other than
 * `pairing`: `pairing`'s, and one that names none, stay.
 */
export function closeReceivedOutside(notifications: Iterable<Shown>, pairing: DeviceId): void {
  for (const notification of notifications) {
    const from = decodePairing(notification.data);
    if (Option.isSome(from) && from.value.pairing !== pairing) notification.close();
  }
}

/**
 * Shows a notification through the service worker where there is one, since
 * some browsers (Android's) show none otherwise, and from the page where
 * there is not. A click focuses a window of the app and hands it the click:
 * the service worker's window through its message, this one directly.
 *
 * `currentPairing` is the pairing the page follows now. Showing takes a while,
 * and a pairing that ends meanwhile closes what it received before this one
 * shows, so the pairing is checked again before showing and once shown.
 */
export async function showNotification(
  shown: ShownNotification,
  currentPairing: () => DeviceId | null,
): Promise<void> {
  const ended = () => currentPairing() !== shown.pairing;
  const options: NotificationOptions = {
    body: shown.body,
    tag: shown.tag,
    icon: shown.icon,
    data: { target: shown.target, pairing: shown.pairing },
  };
  const registration = await activeServiceWorker();
  if (ended()) return;
  if (registration !== null) {
    await registration.showNotification(shown.title, options);
    if (!ended()) return;
    closeReceivedUnder(await registration.getNotifications({ tag: shown.tag }), shown.pairing);
    return;
  }
  // Shown from the page at once, and listed before a pairing that ends could look.
  const notification = new Notification(shown.title, options);
  const entry = { notification, pairing: shown.pairing };
  shownByPage.add(entry);
  notification.addEventListener("close", () => shownByPage.delete(entry));
  notification.addEventListener("click", () => {
    window.focus();
    clicked({ target: shown.target, pairing: shown.pairing });
    notification.close();
  });
}

/**
 * Closes every notification the pairing `ended` received, so none outlives
 * the pairing it belongs to: once it ends, its bots' names and words leave
 * the screen too. Only that pairing's: a pairing never comes back, so this is
 * right however late it runs, and a newer pairing keeps what it showed, even
 * one this window has not heard of yet, as when another tab pairs again.
 */
export async function closeNotificationsOf(ended: DeviceId): Promise<void> {
  for (const entry of shownByPage) {
    if (entry.pairing === ended) entry.notification.close();
  }
  const registration = await activeServiceWorker();
  if (registration !== null) closeReceivedUnder(await registration.getNotifications(), ended);
}

/**
 * Closes every notification another pairing received, once a window first
 * knows the pairing it follows, `first`. A window that was closed while it
 * swept a pairing that ended leaves that pairing's on screen; the next window
 * to start closes them. Safe then, and only then: `first` is the newest
 * pairing the browser keeps, so any other has ended. A pairing that replaces
 * `first` while the browser lists them is newer, so the sweep stops and
 * leaves the change of pairing to close what `first` received.
 */
export async function closeNotificationsOutside(
  first: DeviceId,
  currentPairing: () => DeviceId | null,
): Promise<void> {
  const registration = await activeServiceWorker();
  if (registration === null) return;
  const shown = await registration.getNotifications();
  if (currentPairing() === first) closeReceivedOutside(shown, first);
}

const decodeClick = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal(NOTIFICATION_CLICK),
    target: EntryTarget,
    pairing: DeviceId,
  }),
);

/**
 * Listens for the notification clicks the service worker hands to this
 * window. Called once, as the page starts: a window the service worker opens
 * for a click gets the click as soon as it loads, before the app is ready to
 * act on it, and it waits until then.
 */
export function listenForNotificationClicks(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const click = decodeClick(event.data);
    if (Option.isSome(click)) clicked({ target: click.value.target, pairing: click.value.pairing });
  });
}

/**
 * Calls `handle` with each notification click, starting with one that
 * arrived before anything handled it. Returns the function that stops.
 */
export function onNotificationClick(handle: (click: NotificationClick) => void): () => void {
  handlers.add(handle);
  if (pending !== null) {
    const click = pending;
    pending = null;
    handle(click);
  }
  return () => handlers.delete(handle);
}
