// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The interface's sentences in every language J3 Bots has, and the sentences
 * every client and the server word the same way, such as a notification's.
 * Free of any interface library: the web, desktop and mobile clients and the
 * server read the same catalog.
 */
export { createI18n, type I18n, type KeyWith, LANGUAGE_NAMES, resolveLocale } from "./i18n.ts";
export { type NotificationNames, type NotificationText, notificationText } from "./notification.ts";
