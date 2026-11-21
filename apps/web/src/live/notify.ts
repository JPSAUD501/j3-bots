// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryTarget } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NOTIFICATION_CLICK } from "../../pwa/notificationClick";
import type { NotificationContent } from "../presentation/notification";

interface ShownNotification extends NotificationContent {
  /**
   * One per entry: every window of the browser shows the notifications the
   * server sends, and the browser keeps one notification per tag.
   */
  readonly tag: string;
  readonly target: EntryTarget;
  /** The page of `target`, on this origin. */
  readonly url: string;
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

/**
 * Shows a notification through the service worker where there is one, since
 * some browsers (Android's) show none otherwise, and from the page where
 * there is not. A click focuses a window of the app and opens `target` in it:
 * the service worker's window through `onServiceWorkerClick`, this one
 * through `open`.
 */
export async function showNotification(
  shown: ShownNotification,
  open: (target: EntryTarget) => void,
): Promise<void> {
  const options: NotificationOptions = {
    body: shown.body,
    tag: shown.tag,
    icon: "/icon-192.png",
    data: { target: shown.target, url: shown.url },
  };
  const registration = await activeServiceWorker();
  if (registration !== null) {
    await registration.showNotification(shown.title, options);
    return;
  }
  const notification = new Notification(shown.title, options);
  notification.addEventListener("click", () => {
    window.focus();
    open(shown.target);
    notification.close();
  });
}

const decodeClick = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal(NOTIFICATION_CLICK), target: EntryTarget }),
);

/**
 * Calls `open` with the target of each notification click the service worker
 * hands to this window. Returns the function that stops listening.
 */
export function onServiceWorkerClick(open: (target: EntryTarget) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => undefined;
  const listener = (event: MessageEvent<unknown>) => {
    const click = decodeClick(event.data);
    if (Option.isSome(click)) open(click.value.target);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
