// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { BotId, DeviceId, Label, NonNegativeInt, OpenLiterals } from "./base.ts";

// ---------------------------------------------------------------------------
// Secrets: what the operator types for bots to use without reading
// (docs/architecture/server.md, "Secrets"). A secret is a login or a single
// value, sealed on the server under a key it holds itself. Every value travels
// as a redacted type: printing, logging or failing on one shows `<redacted>`,
// never the value. A bot names a secret by reference (`secret:<name>`), and
// the server puts the value where it is used.
// ---------------------------------------------------------------------------

/**
 * A secret's id. The client that adds it chooses it, so adding again after a
 * lost reply finds the secret it added instead of adding another. Logins
 * saved before secrets kept the `cred_` ids they had.
 */
export const SecretId = Schema.String.check(
  Schema.isPattern(/^(?:sec|cred)_[0-9a-z]{16,40}$/),
).pipe(Schema.brand("SecretId"));
export type SecretId = typeof SecretId.Type;

/** The longest name a secret takes. */
export const MAX_SECRET_NAME_LENGTH = 64;

/**
 * A secret's name: what a reference names it by (`secret:<name>`), unique
 * among the operator's secrets. Lower-case letters, digits, `-` and `_`,
 * starting with a letter or a digit, so it reads the same in a header, an
 * argument or an environment variable's value.
 */
export const SecretName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)).pipe(
  Schema.brand("SecretName"),
);
export type SecretName = typeof SecretName.Type;

/** What a bot is handed for a secret: its reference, never its value. */
export const secretReference = (name: SecretName): string => `secret:${name}`;

/**
 * Where a connector's setting takes a secret's value: `${secret:<name>}`, or
 * `${secret:<name>.username}` / `.password` for a login's, anywhere in its
 * text. The name is captured first and the login's value second. Anything
 * else between `${secret:` and `}` is not a reference. A new expression each
 * call, since a global one keeps where it last matched.
 */
export const secretReferencePattern = (): RegExp =>
  new RegExp(
    `\\$\\{secret:([a-z0-9][a-z0-9_-]{0,${MAX_SECRET_NAME_LENGTH - 1}})(?:\\.(username|password))?\\}`,
    "g",
  );

/** Whether `text` holds a reference to a secret, whose value the server puts there. */
export const holdsSecretReference = (text: string): boolean => secretReferencePattern().test(text);

// Not `link.ts`'s parser: that module reaches the entries, which reach this one.
const parseUrl: (text: string) => Option.Option<URL> = Option.liftThrowable(
  (text: string) => new URL(text),
);

const isHttp = (url: URL) => url.protocol === "http:" || url.protocol === "https:";

/**
 * Where a login is used: an `http:` or `https:` origin, scheme, host and
 * port exactly, in the form a browser writes it (a punycode host, no default
 * port). Never a domain or a pattern: `https://example.com` does not cover
 * `https://accounts.example.com`.
 */
export const SiteOrigin = Schema.String.check(
  Schema.makeFilter(
    (text: string) =>
      Option.exists(parseUrl(text), (url) => isHttp(url) && url.origin === text) ||
      "an http: or https: origin",
  ),
).pipe(Schema.brand("SiteOrigin"));
export type SiteOrigin = typeof SiteOrigin.Type;

const decodeSiteOrigin = Schema.decodeUnknownOption(SiteOrigin);

/**
 * The origin of what was typed or given: a whole address (`https://example.com/login`
 * gives `https://example.com`), or a bare host, read as `https`. None when it
 * names no `http:` or `https:` origin, or carries a user name.
 */
export const siteOriginOf = (text: string): Option.Option<SiteOrigin> => {
  const typed = text.trim();
  if (typed === "") return Option.none();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  return Option.flatMap(parseUrl(withScheme), (url) =>
    isHttp(url) && url.username === "" && url.password === ""
      ? decodeSiteOrigin(url.origin)
      : Option.none(),
  );
};

/** The most origins one login is saved for. */
export const MAX_LOGIN_ORIGINS = 10;

export const LoginOrigins = Schema.NonEmptyArray(SiteOrigin).check(
  Schema.isMaxLength(MAX_LOGIN_ORIGINS),
);
export type LoginOrigins = typeof LoginOrigins.Type;

/**
 * A secret of `min` to `max` characters, redacted as soon as it is decoded
 * and checked only then, so neither a refused value nor a log of the
 * request prints it.
 */
const secret = (min: number, max: number) =>
  Schema.Redacted(Schema.String).check(
    Schema.makeFilter(
      (value: Redacted.Redacted<string>) => {
        const length = Redacted.value(value).length;
        return length >= min && length <= max;
      },
      { expected: `a value of ${min} to ${max} characters` },
    ),
  );

/** A login's user name. Some logins have none. */
export const LoginUsername = secret(0, 1_000);
export const LoginPassword = secret(1, 10_000);

/**
 * A one-time code generator, as the site gives it: the secret in base32, or
 * an `otpauth://totp/` address that carries it with its settings.
 */
export const TotpSetup = secret(1, 4_000);

/** A single value: a token, an API key. */
export const SecretValue = secret(1, 10_000);

/**
 * One value of a secret, as `secrets.reveal` gives it back and a reference can
 * name it: a single value's `value`, or a login's `username`, `password` or
 * `totp` (its base32 key).
 */
export const SecretField = Schema.Literals(["value", "username", "password", "totp"]);
export type SecretField = typeof SecretField.Type;

/** What a secret is, without a value: a login for some sites, or a single value. */
export const SecretKind = Schema.Union([
  Schema.TaggedStruct("login", {
    origins: LoginOrigins,
    /** Whether it has a one-time code generator. */
    hasTotp: Schema.Boolean,
  }),
  Schema.TaggedStruct("value", {}),
]);
export type SecretKind = typeof SecretKind.Type;

/**
 * Which bots may use a secret: every bot, the ones the operator makes later
 * included, or the ones named. A bot that asked for a secret may use it once
 * it is saved; the operator widens that.
 */
export const SecretAccess = Schema.Union([
  Schema.TaggedStruct("every-bot", {}),
  Schema.TaggedStruct("bots", { botIds: Schema.Array(BotId) }),
]);
export type SecretAccess = typeof SecretAccess.Type;

/** Whether `access` lets `botId` use the secret. */
export const accessAllows = (access: SecretAccess, botId: BotId): boolean =>
  access._tag === "every-bot" || access.botIds.includes(botId);

/**
 * Where a bot last used a secret: typed into its browser on a site, or sent
 * to a connector, named as the operator named it.
 */
export const SecretUse = Schema.Union([
  Schema.TaggedStruct("browser", { origin: SiteOrigin }),
  Schema.TaggedStruct("connector", { name: Label }),
]);
export type SecretUse = typeof SecretUse.Type;

/** What a secret says of itself, without a value. */
export const Secret = Schema.Struct({
  id: SecretId,
  name: SecretName,
  kind: SecretKind,
  access: SecretAccess,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  /** The last time a bot used it, and where. */
  lastUse: Schema.NullOr(Schema.Struct({ at: Schema.DateTimeUtc, botId: BotId, use: SecretUse })),
  /** The last time a value of it was shown, on which device, and which one. */
  lastReveal: Schema.NullOr(
    Schema.Struct({ at: Schema.DateTimeUtc, deviceId: DeviceId, field: SecretField }),
  ),
});
export type Secret = typeof Secret.Type;

/**
 * - `ready`: secrets can be added and used.
 * - `old-vault`: a vault sealed under a master password, from before secrets,
 *   waits for that password. Only a server of 0.12 or earlier says it, and
 *   only that server's own web app takes the password; a later server
 *   refuses to start over such a vault.
 * - `unreadable`: secrets are saved, and the key that opens them is missing
 *   or is another one: its file was deleted or replaced. Nothing in them can
 *   be read until the key is put back, or the operator starts over.
 * - `newer`: a newer release of J3 Bots changed the secrets' file, as before
 *   a rollback to this one, which a rollback does not undo. This release
 *   cannot read it; the release that changed it can.
 */
export const SecretsState = Schema.Literals(["ready", "old-vault", "unreadable", "newer"]);
export type SecretsState = typeof SecretsState.Type;

export const SecretsStatus = Schema.Struct({
  state: SecretsState,
  /**
   * Counts every change to the secrets since the server started, so a client
   * reads `secrets.list` again when it moves.
   */
  revision: NonNegativeInt,
});
export type SecretsStatus = typeof SecretsStatus.Type;

/** A new secret's values, as `secrets.add` takes them. */
export const SecretDraft = Schema.Union([
  Schema.TaggedStruct("login", {
    origins: LoginOrigins,
    username: LoginUsername,
    password: LoginPassword,
    totp: Schema.NullOr(TotpSetup),
  }),
  Schema.TaggedStruct("value", { value: SecretValue }),
]);
export type SecretDraft = typeof SecretDraft.Type;

/**
 * What `secrets.update` changes. Fields left out keep their value; `totp:
 * null` removes a login's one-time codes. A login's fields on a single value,
 * or `value` on a login, are refused.
 */
export const SecretChanges = Schema.Struct({
  name: Schema.optionalKey(SecretName),
  origins: Schema.optionalKey(LoginOrigins),
  username: Schema.optionalKey(LoginUsername),
  password: Schema.optionalKey(LoginPassword),
  totp: Schema.optionalKey(Schema.NullOr(TotpSetup)),
  value: Schema.optionalKey(SecretValue),
});
export type SecretChanges = typeof SecretChanges.Type;

/** A TOTP code now, and when it stops being valid. */
export const TotpPreview = Schema.Struct({
  code: Schema.Redacted(Schema.String),
  validUntil: Schema.DateTimeUtc,
});
export type TotpPreview = typeof TotpPreview.Type;

// ---------------------------------------------------------------------------
// Filling a saved login into a bot's browser tab (docs/architecture/server.md,
// "Filling a login"). The bot names the login and the field; the server types
// the value into the bot's tab while it holds the tab, and the bot learns only
// how it went. Nothing below carries a value.
// ---------------------------------------------------------------------------

/** The value of a login a fill types. */
export const FillField = Schema.Literals(["username", "password", "totp"]);
export type FillField = typeof FillField.Type;

/**
 * Why a fill did not finish. With every reason but `unavailable`, nothing was
 * typed.
 *
 * - `no-access`: the bot's browser is off.
 * - `unknown-login`: no login of that name may be used by this bot.
 * - `no-value`: the login has no such value: no user name, or no one-time code.
 * - `no-tab`: the bot has no tab open.
 * - `held`: a person holds the tab.
 * - `loading`: the page was still loading.
 * - `insecure`: the page is plain `http:` on another computer.
 * - `origin`: the page's origin is none of the login's.
 * - `navigated`: the page changed while the server held the tab.
 * - `refused-before`: a fill was refused on this tab earlier in this turn.
 * - `stopped`: the bot's turn was stopped or ended before anything was typed.
 * - `unavailable`: the browser or the secrets could not be reached, or the
 *   browser did not confirm that it ran the typing.
 */
export const FillRefusal = Schema.Literals([
  "no-access",
  "unknown-login",
  "no-value",
  "no-tab",
  "held",
  "loading",
  "insecure",
  "origin",
  "navigated",
  "refused-before",
  "stopped",
  "unavailable",
]);
export type FillRefusal = typeof FillRefusal.Type;

/**
 * How a fill went: typed (`submitted` when the server also pressed Enter,
 * which it always does after a password), or refused.
 */
export const FillOutcome = Schema.Union([
  Schema.TaggedStruct("filled", { submitted: Schema.Boolean }),
  Schema.TaggedStruct("refused", { reason: FillRefusal }),
]);
export type FillOutcome = typeof FillOutcome.Type;

/** A refusal's reason as a client receives it: one added after this build decodes as `unknown`. */
const ReceivedFillOutcome = Schema.Union([
  Schema.TaggedStruct("filled", { submitted: Schema.Boolean }),
  Schema.TaggedStruct("refused", { reason: OpenLiterals(FillRefusal.literals) }),
]);

/**
 * One fill, as the work fold shows it (`WorkStep.fill`). The origin is the
 * page's as the server checked it, in ASCII, so a lookalike name shows as
 * its punycode.
 */
export const CredentialFill = Schema.Struct({
  /** The login's name, as the bot asked for it. */
  name: Label,
  /** The login filled or refused, or null when none answered to the name. */
  secretId: Schema.NullOr(SecretId),
  field: FillField,
  /** The page's origin, or null when there was no tab or its page has no `http:` or `https:` origin. */
  origin: Schema.NullOr(SiteOrigin),
  outcome: ReceivedFillOutcome,
});
export type CredentialFill = typeof CredentialFill.Type;
