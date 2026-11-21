// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId, EntryTarget } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NOTIFICATION_CLICK } from "../../pwa/notificationClick";
import type { NotificationContent } from "../presentation/notification";

/** A click on a notification: what it was about, and the pairing that received it. */
interface NotificationClick {
  readonly target: EntryTarget;
  readonly pairing: DeviceId;
}

interface ShownNotification extends NotificationContent, NotificationClick {
  /**
   * One per entry: every window of the browser shows the notifications the
   * server sends, and the browser keeps one notification per tag.
   */
  readonly tag: string;
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

/**
 * Shows a notification through the service worker where there is one, since
 * some browsers (Android's) show none otherwise, and from the page where
 * there is not. A click focuses a window of the app and hands it the click:
 * the service worker's window through its message, this one directly.
 */
export async function showNotification(shown: ShownNotification): Promise<void> {
  const options: NotificationOptions = {
    body: shown.body,
    tag: shown.tag,
    icon: "/icon-192.png",
    data: { target: shown.target, pairing: shown.pairing },
  };
  const registration = await activeServiceWorker();
  if (registration !== null) {
    await registration.showNotification(shown.title, options);
    return;
  }
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

const decodePairing = Schema.decodeUnknownOption(Schema.Struct({ pairing: DeviceId }));

/**
 * Closes every notification a pairing other than `pairing` received, so none
 * outlives the pairing it belongs to: once it ends, its bots' names and words
 * leave the screen too.
 */
export async function closeNotificationsOutside(pairing: DeviceId | null): Promise<void> {
  for (const entry of shownByPage) {
    if (entry.pairing !== pairing) entry.notification.close();
  }
  const registration = await activeServiceWorker();
  if (registration === null) return;
  for (const notification of await registration.getNotifications()) {
    const from = decodePairing(notification.data);
    if (Option.isNone(from) || from.value.pairing !== pairing) notification.close();
  }
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
