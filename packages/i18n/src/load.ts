// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Language } from "@j3-bots/contracts";
import { type Catalog, type I18n, i18nOf } from "./i18n.ts";

/**
 * The interface's sentences in `locale`, once its catalog has loaded: only
 * that language's catalog is fetched.
 */
export const loadI18n = (locale: Language): Promise<I18n> =>
  loaders[locale]().then((catalog) => i18nOf(locale, catalog));

const loaders: Record<Language, () => Promise<Catalog>> = {
  en: () => import("./en.ts").then((module) => module.en),
  "pt-BR": () => import("./pt-BR.ts").then((module) => module.ptBR),
};
