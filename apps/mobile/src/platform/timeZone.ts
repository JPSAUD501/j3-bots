// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCalendars } from "expo-localization";

/**
 * The phone's time zone, from its first calendar: React Native has no other
 * place to read it. Null when the phone names none.
 */
export const phoneTimeZone = (): string | null => getCalendars()[0]?.timeZone ?? null;
