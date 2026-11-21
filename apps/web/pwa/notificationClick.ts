// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The message the service worker posts to a window when the operator clicks
 * a notification it showed: `{ type: NOTIFICATION_CLICK, target, pairing }`,
 * where `target` is the conversation or room it is about and `pairing` the
 * device id that received it.
 */
export const NOTIFICATION_CLICK = "j3:notification-click";
