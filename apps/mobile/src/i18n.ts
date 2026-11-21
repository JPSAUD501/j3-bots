// SPDX-License-Identifier: AGPL-3.0-or-later
import type { I18n } from "@j3-bots/i18n";
import { createContext, useContext } from "react";

export const I18nContext = createContext<I18n | null>(null);

export const useI18n = (): I18n => {
  const i18n = useContext(I18nContext);
  if (i18n === null) throw new Error("useI18n needs an I18nContext above it.");
  return i18n;
};
