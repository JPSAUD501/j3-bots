// SPDX-License-Identifier: AGPL-3.0-or-later
import { en } from "./en";
import { ptBR } from "./pt-BR";

/**
 * The translation layer. English is the source: `en.ts` holds every interface
 * sentence, whole, with `{name}` placeholders. Other catalogs must have every
 * key and keep every placeholder, or they do not type-check.
 *
 * Plural sentences are two keys, `….one` and `….other`, chosen with the
 * locale's plural rules.
 */

export const locales = ["en", "pt-BR"] as const;
export type Locale = (typeof locales)[number];

type Source = typeof en;
type MessageKey = keyof Source;

type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | Placeholders<Rest>
  : never;

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

/** A translated sentence: any text that keeps the source's placeholders. */
type Keeping<P extends string> = [P] extends [never]
  ? string
  : UnionToIntersection<P extends string ? `${string}{${P}}${string}` : never>;

export type Catalog = { readonly [K in MessageKey]: Keeping<Placeholders<Source[K]>> };

type Params<K extends MessageKey> = Placeholders<Source[K]>;

/** The keys whose sentences take exactly the placeholders `P`: by default, none. */
export type KeyWith<P extends string = never> = {
  [K in MessageKey]: [Params<K>] extends [P] ? ([P] extends [Params<K>] ? K : never) : never;
}[MessageKey];

type Args<K extends MessageKey> = [Params<K>] extends [never]
  ? []
  : [params: Readonly<Record<Params<K>, string | number>>];

type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.other` ? Base : never;
}[MessageKey];

type PluralArgs<B extends PluralKey> =
  Exclude<Params<`${B}.other`>, "count"> extends infer P extends string
    ? [P] extends [never]
      ? []
      : [params: Readonly<Record<P, string | number>>]
    : never;

const catalogs: Record<Locale, Catalog> = { en, "pt-BR": ptBR };

export interface I18n {
  readonly locale: Locale;
  /** A sentence from the catalog, with its placeholders filled in. */
  t<K extends MessageKey>(key: K, ...args: Args<K>): string;
  /**
   * A sentence split around its placeholders, whose values stay as given: for
   * a value drawn apart from the words around it, such as a command.
   */
  parts<K extends MessageKey, V extends object>(
    key: K,
    values: Readonly<Record<Params<K>, V>>,
  ): ReadonlyArray<string | V>;
  /** A sentence that depends on a count, which fills `{count}`. */
  plural<B extends PluralKey>(key: B, count: number, ...args: PluralArgs<B>): string;
  /**
   * A plural sentence split around its other placeholders, whose values stay
   * as given: for a value drawn apart from the words around it.
   */
  pluralParts<B extends PluralKey, V extends object>(
    key: B,
    count: number,
    values: Readonly<Record<Exclude<Params<`${B}.other`>, "count">, V>>,
  ): ReadonlyArray<string | V>;
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function createI18n(locale: Locale): I18n {
  const catalog = catalogs[locale];
  const numbers = new Intl.NumberFormat(locale);
  const pluralRules = new Intl.PluralRules(locale);
  const fill = (text: string, params: Readonly<Record<string, string | number>> = {}) =>
    text.replace(PLACEHOLDER, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) return whole;
      return typeof value === "number" ? numbers.format(value) : value;
    });
  const isKey = (key: string): key is MessageKey => key in catalog;
  const lookup = (key: string): string => {
    if (!isKey(key)) throw new Error(`Missing message: ${key}`);
    return catalog[key];
  };
  const split = <V extends object>(text: string, values: Readonly<Record<string, V>>) => {
    const parts: Array<string | V> = [];
    let from = 0;
    for (const match of text.matchAll(PLACEHOLDER)) {
      const value = match[1] === undefined ? undefined : values[match[1]];
      if (value === undefined) continue;
      parts.push(text.slice(from, match.index), value);
      from = match.index + match[0].length;
    }
    parts.push(text.slice(from));
    return parts.filter((part) => part !== "");
  };
  const pluralText = (key: string, count: number) => {
    const one = `${key}.one`;
    return lookup(pluralRules.select(count) === "one" && one in catalog ? one : `${key}.other`);
  };
  return {
    locale,
    t: (key, ...args) => fill(catalog[key], args[0]),
    parts: <V extends object>(key: MessageKey, values: Readonly<Record<string, V>>) =>
      split(catalog[key], values),
    plural: (key, count, ...args) => fill(pluralText(key, count), { ...args[0], count }),
    pluralParts: <V extends object>(
      key: string,
      count: number,
      values: Readonly<Record<string, V>>,
    ) => split(fill(pluralText(key, count), { count }), values),
  };
}

/** The first of the reader's languages that J3 Bots has, by language when no region matches. */
export function resolveLocale(preferred: ReadonlyArray<string>): Locale {
  for (const tag of preferred) {
    const exact = locales.find((l) => l.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const language = tag.split("-")[0]?.toLowerCase();
    const sameLanguage = locales.find((l) => l.split("-")[0]?.toLowerCase() === language);
    if (sameLanguage) return sameLanguage;
  }
  return "en";
}
