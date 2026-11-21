// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n, type I18n, resolveLocale } from "@j3-bots/i18n";
import { getLocales } from "expo-localization";
import { createContext, useContext } from "react";

/** The catalog in the first of the device's languages J3 Bots has. */
export const deviceI18n = (): I18n =>
  createI18n(resolveLocale(getLocales().map((locale) => locale.languageTag)));

export const I18nContext = createContext<I18n | null>(null);

export const useI18n = (): I18n => {
  const i18n = useContext(I18nContext);
  if (i18n === null) throw new Error("useI18n needs an I18nContext above it.");
  return i18n;
};
