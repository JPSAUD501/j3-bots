// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConnectKind,
  ConnectorGlyph,
  type ConnectorListing,
  type ConnectorListingDetails,
  type ConnectorSetup,
  CuratedKey,
  type Language,
  LANGUAGES,
  RegistryName,
  SetupPageUrl,
} from "@j3-bots/contracts";
import { isConnectorGlyphName } from "@j3-bots/design-tokens";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import shipped from "./curated.json" with { type: "json" };
import { type ConnectForm, connectForm, contractFields } from "./form.ts";

// J3 Bots' own list of connectors: services reviewed for each release, with
// text written for J3 Bots in every language it has, and their addresses in
// the file, so the gallery works when the MCP Registry does not answer. Every
// value here was reviewed by a person; still, the file is decoded like any
// other, and a list that breaks a rule below is refused when the server
// starts, which its test catches first.

const Written = Schema.String.check(Schema.isMinLength(1));

/**
 * Text in every language the interface has, each written whole. A language
 * added to `Language` and missing here fails to type-check where the text is
 * read.
 */
const Localized = Schema.Struct({ en: Written, "pt-BR": Written });
type Localized = typeof Localized.Type;

const https = (text: string) => {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
};

/** An https address with no user name or fragment, as every address in the list is. */
const HttpsUrl = Schema.String.check(
  Schema.makeFilter(
    (text: string) => https(text) || "an https address with no user name or fragment",
  ),
);

const Glyph = ConnectorGlyph.check(
  Schema.makeFilter((name: string) => isConnectorGlyphName(name) || "one of J3 Bots' own glyphs"),
);

/** A header name as HTTP writes it: one token. */
const HeaderName = Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/));

/** The placeholder a token entry's header value puts the operator's token in. */
const TOKEN = "{token}";

/** The placeholder an app's step puts the connector's scopes in. */
const SCOPES = "{scopes}";

const Connect = Schema.Union([
  /** One tap: the service lets any client register itself, so J3 Bots signs in with no setup. */
  Schema.Struct({ kind: Schema.Literal("sign-in") }),
  /** A token the operator makes at the service, sent in one header. */
  Schema.Struct({
    kind: Schema.Literal("token"),
    header: HeaderName,
    /** The header's value, with `{token}` where the token goes. */
    value: Schema.String.check(
      Schema.makeFilter((value: string) => value.includes(TOKEN) || `a value with ${TOKEN} in it`),
    ),
    label: Localized,
    /** Where the operator makes the token. */
    page: HttpsUrl,
    steps: Schema.NonEmptyArray(Localized),
  }),
  /** A sign-in with an OAuth client the operator registers at the service. */
  Schema.Struct({
    kind: Schema.Literal("own-app"),
    app: Schema.String,
    scopes: Schema.NonEmptyArray(Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/))),
  }),
]);

/** An OAuth client the operator registers once, which serves every connector that names it. */
const App = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  /** Where its setup starts. */
  setupUrl: HttpsUrl,
  /** What the operator must know before starting, such as a preview's terms. */
  note: Schema.NullOr(Localized),
  /** In order. `{scopes}` stands for the scopes of the connector being set up. */
  steps: Schema.NonEmptyArray(Localized),
  /** Sent with every sign-in through it, such as Google's request for a lasting sign-in. */
  authorizationParameters: Schema.Record(Schema.String, Schema.String),
});

const Entry = Schema.Struct({
  id: CuratedKey,
  /** A service's own name, which is not translated, or a name with words of J3 Bots' own. */
  name: Schema.Union([Schema.String.check(Schema.isMinLength(1)), Localized]),
  /** Its entry in the MCP Registry, if it has one: a registry result by this name shows as this entry. */
  registryName: Schema.NullOr(RegistryName),
  /** The domain of the company that runs it, as its page names it. */
  publisher: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)),
  category: Schema.String,
  glyph: Glyph,
  /** One line, J3 Bots' own words. */
  summary: Localized,
  remote: Schema.Struct({ type: Schema.Literal("streamable-http"), url: HttpsUrl }),
  connect: Connect,
});
export type CuratedEntry = typeof Entry.Type;

/**
 * The entry's remote as the registry would describe it: a token entry sends
 * its token in its header, as a secret the form must have.
 */
const remoteOf = (entry: CuratedEntry) => ({
  type: entry.remote.type,
  url: entry.remote.url,
  headers:
    entry.connect.kind === "token"
      ? [
          {
            name: entry.connect.header,
            value: entry.connect.value,
            isSecret: true,
            isRequired: true,
          },
        ]
      : [],
});

/** What is wrong with a list whose entries each decode, or `undefined`. */
const listProblem = (list: {
  readonly categories: Readonly<Record<string, Localized>>;
  readonly apps: Readonly<Record<string, typeof App.Type>>;
  readonly connectors: ReadonlyArray<CuratedEntry>;
}): string | undefined => {
  const ids = new Set<string>();
  for (const entry of list.connectors) {
    if (ids.has(entry.id)) return `${entry.id} is listed twice`;
    ids.add(entry.id);
    if (!Object.hasOwn(list.categories, entry.category)) return `${entry.id} has no such category`;
    if (entry.connect.kind === "own-app" && !Object.hasOwn(list.apps, entry.connect.app)) {
      return `${entry.id} names no such app`;
    }
    if (Result.isFailure(connectForm(remoteOf(entry)))) return `${entry.id} cannot be connected`;
  }
  for (const [name, app] of Object.entries(list.apps)) {
    const scoped = app.steps.some((step) =>
      LANGUAGES.some((language) => step[language].includes(SCOPES)),
    );
    const users = list.connectors.filter(
      (entry) => entry.connect.kind === "own-app" && entry.connect.app === name,
    );
    if (users.length === 0) return `no connector uses ${name}`;
    // A step that lists scopes lists those of one connector: an app that
    // shows them serves one.
    if (scoped && users.length > 1) return `${name} lists scopes but serves several connectors`;
  }
  return undefined;
};

const CuratedList = Schema.Struct({
  categories: Schema.Record(Schema.String, Localized),
  apps: Schema.Record(Schema.String, App),
  connectors: Schema.NonEmptyArray(Entry),
}).check(Schema.makeFilter((list) => listProblem(list) ?? true));
export type CuratedList = typeof CuratedList.Type;

/** Decodes a curated list; exported so its test can refuse broken ones. */
export const decodeCuratedList = Schema.decodeUnknownResult(CuratedList);

/** The list that ships with this release. */
export const CURATED: CuratedList = Schema.decodeUnknownSync(CuratedList)(shipped);

const text = (localized: Localized, language: Language) => localized[language];

const nameOf = (entry: CuratedEntry, language: Language) =>
  typeof entry.name === "string" ? entry.name : text(entry.name, language);

/** The connect form of an entry. Every shipped entry has one: the list is refused otherwise. */
export const curatedForm = (entry: CuratedEntry): ConnectForm => {
  const form = connectForm(remoteOf(entry));
  if (Result.isFailure(form)) throw new Error(`${entry.id} cannot be connected`);
  return form.success;
};

const connectKind = (entry: CuratedEntry): ConnectKind => {
  switch (entry.connect.kind) {
    case "sign-in":
      return "sign-in";
    case "token":
      return "token";
    case "own-app":
      return "own-app";
  }
};

const curatedRef = (entry: CuratedEntry) => ({ _tag: "curated" as const, key: entry.id });

export const curatedListing = (entry: CuratedEntry, language: Language): ConnectorListing => ({
  ref: curatedRef(entry),
  name: nameOf(entry, language),
  summary: text(entry.summary, language),
  glyph: entry.glyph,
  publisher: { _tag: "domain", domain: entry.publisher },
  connect: connectKind(entry),
});

const setupOf = (
  list: CuratedList,
  entry: CuratedEntry,
  language: Language,
): ConnectorSetup | null => {
  switch (entry.connect.kind) {
    case "sign-in":
      return null;
    case "token":
      return {
        steps: entry.connect.steps.map((step) => text(step, language)),
        url: SetupPageUrl.make(entry.connect.page),
      };
    case "own-app": {
      const app = list.apps[entry.connect.app];
      if (app === undefined) return null;
      const scopes = entry.connect.scopes.join(", ");
      return {
        steps: app.steps.map((step) => text(step, language).replaceAll(SCOPES, scopes)),
        url: SetupPageUrl.make(app.setupUrl),
      };
    }
  }
};

/** What the operator must know before connecting, beyond the summary, if anything. */
const noteOf = (list: CuratedList, entry: CuratedEntry, language: Language) => {
  if (entry.connect.kind !== "own-app") return null;
  const note = list.apps[entry.connect.app]?.note;
  return note === null || note === undefined ? null : text(note, language);
};

export const curatedDetails = (
  list: CuratedList,
  entry: CuratedEntry,
  language: Language,
): ConnectorListingDetails => {
  const note = noteOf(list, entry, language);
  const summary = text(entry.summary, language);
  const label = entry.connect.kind === "token" ? text(entry.connect.label, language) : null;
  return {
    ...curatedListing(entry, language),
    description: note === null ? summary : `${summary}\n\n${note}`,
    fields: contractFields(curatedForm(entry)).map((field) =>
      label === null ? field : { ...field, label },
    ),
    setup: setupOf(list, entry, language),
    command: null,
    tools: null,
  };
};

/** Text folded for matching: lower case, without accents. */
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Whether `query` is in the entry's name, summary, category or publisher, in
 * any language: so "email" finds Gmail and "agenda" finds Calendar, which the
 * registry, matching names only, would not.
 */
export const curatedMatches = (list: CuratedList, entry: CuratedEntry, query: string) => {
  const words = fold(query.trim());
  if (words === "") return false;
  const category = list.categories[entry.category];
  const texts = [
    entry.id,
    entry.publisher,
    ...LANGUAGES.flatMap((language) => [
      nameOf(entry, language),
      text(entry.summary, language),
      ...(category === undefined ? [] : [text(category, language)]),
    ]),
  ];
  return texts.some((value) => fold(value).includes(words));
};

/** The entry `key` names, if the list has it. */
export const curatedEntry = (list: CuratedList, key: string) =>
  list.connectors.find((entry) => entry.id === key);

/**
 * The entry a bot means by `service`: the one whose key or name, in any
 * language, is it. No search: one that matched a summary or a category could
 * offer another service than the one the bot named.
 */
export const curatedFind = (list: CuratedList, service: string): CuratedEntry | undefined => {
  const wanted = fold(service.trim());
  if (wanted === "") return undefined;
  return list.connectors.find(
    (entry) =>
      entry.id === wanted || LANGUAGES.some((language) => fold(nameOf(entry, language)) === wanted),
  );
};

/**
 * The entries that reach the same service as the entry `key` names, by their
 * address: that entry, and another way to connect it, such as with a key
 * instead of a sign-in.
 */
export const curatedVariants = (list: CuratedList, key: string) => {
  const entry = curatedEntry(list, key);
  return entry === undefined
    ? []
    : list.connectors.filter((other) => other.remote.url === entry.remote.url).map(curatedRef);
};

/** Whether a registry entry is one the list already has: by its name, or by its address. */
export const curatedCovers = (list: CuratedList, name: string, urls: ReadonlyArray<string>) =>
  list.connectors.some((entry) => entry.registryName === name || urls.includes(entry.remote.url));
