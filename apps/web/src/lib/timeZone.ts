// SPDX-License-Identifier: AGPL-3.0-or-later

/** The time zone the browser, or the system under the desktop app, says it is in. */
export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
