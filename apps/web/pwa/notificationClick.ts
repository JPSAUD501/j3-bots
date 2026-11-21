// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The message the service worker posts to a window when the operator clicks
 * a notification it showed: `{ type: NOTIFICATION_CLICK, target }`, where
 * `target` is the conversation or room to open.
 */
export const NOTIFICATION_CLICK = "j3:notification-click";
