// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Language } from "@j3-bots/contracts";
import { en } from "./en.ts";
import { type Catalog, type I18n, i18nOf } from "./i18n.ts";
import { ptBR } from "./pt-BR.ts";

const catalogs: Record<Language, Catalog> = { en, "pt-BR": ptBR };

/**
 * The interface's sentences in `locale`, at once: every catalog is loaded
 * with this module. For the server and the apps, which have their code on
 * the machine; a page that downloads its code reads one catalog with
 * `loadI18n`.
 */
export const createI18n = (locale: Language): I18n => i18nOf(locale, catalogs[locale]);
