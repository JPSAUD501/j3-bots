// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { BotId, DeviceId, Label, NonNegativeInt } from "./base.ts";

// ---------------------------------------------------------------------------
// The vault: the operator's saved logins, sealed under a key that comes from
// a master password the server holds in memory only (docs/architecture/
// server.md, "The vault"). Every value travels as a redacted type: printing,
// logging or failing on one shows `<redacted>`, never the value.
// ---------------------------------------------------------------------------

/**
 * A saved login's id. The client that saves it chooses it, so saving again
 * after a lost reply finds the login it saved instead of adding another.
 */
export const CredentialId = Schema.String.check(Schema.isPattern(/^cred_[0-9a-z]{16,40}$/)).pipe(
  Schema.brand("CredentialId"),
);
export type CredentialId = typeof CredentialId.Type;

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
export const MAX_CREDENTIAL_ORIGINS = 10;

export const CredentialOrigins = Schema.NonEmptyArray(SiteOrigin).check(
  Schema.isMaxLength(MAX_CREDENTIAL_ORIGINS),
);
export type CredentialOrigins = typeof CredentialOrigins.Type;

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

/** The shortest master password the vault takes. */
export const MIN_MASTER_PASSWORD_LENGTH = 8;

/**
 * The master password. Only the operator knows it: the server keeps nothing
 * that gives it back, so a forgotten one leaves the vault unreadable.
 */
export const MasterPassword = secret(MIN_MASTER_PASSWORD_LENGTH, 1_024);
export type MasterPassword = typeof MasterPassword.Type;

/** A login's user name. Some logins have none. */
export const CredentialUsername = secret(0, 1_000);
export const CredentialPassword = secret(1, 10_000);

/**
 * A one-time code generator, as the site gives it: the secret in base32, or
 * an `otpauth://totp/` address that carries it with its settings.
 */
export const TotpSetup = secret(1, 4_000);

/** A login's value that `vault.reveal` gives back: the TOTP's is its base32 secret. */
export const CredentialField = Schema.Literals(["username", "password", "totp"]);
export type CredentialField = typeof CredentialField.Type;

/** What a login says of itself, without a value. */
export const Credential = Schema.Struct({
  id: CredentialId,
  /** What the operator calls it, such as "GitHub (work)": the one field a bot may see. */
  name: Label,
  origins: CredentialOrigins,
  /** Whether it has a one-time code generator. */
  hasTotp: Schema.Boolean,
  /** The bots that may use it. None until the operator allows one. */
  allowedBots: Schema.Array(BotId),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  /** The last time a value of it was shown, on which device, and which one. */
  lastReveal: Schema.NullOr(
    Schema.Struct({ at: Schema.DateTimeUtc, deviceId: DeviceId, field: CredentialField }),
  ),
});
export type Credential = typeof Credential.Type;

/**
 * - `uninitialized`: no master password was ever set.
 * - `locked`: the vault exists and its key is not in the server's memory, as
 *   after every start. Nothing in it can be read or changed until a client
 *   unlocks it.
 * - `unlocked`: its key is in memory until a client locks it or the server
 *   stops.
 * - `newer`: a newer release of J3 Bots changed the vault's file, as before a
 *   rollback to this one, which a rollback does not undo. This release
 *   cannot read it; the release that changed it can.
 */
export const VaultState = Schema.Literals(["uninitialized", "locked", "unlocked", "newer"]);
export type VaultState = typeof VaultState.Type;

export const VaultStatus = Schema.Struct({
  state: VaultState,
  /**
   * Counts every change to the saved logins since the server started, so a
   * client reads `vault.list` again when it moves.
   */
  revision: NonNegativeInt,
  /** Until when unlocking is refused after too many wrong passwords; null when it is not. */
  retryAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type VaultStatus = typeof VaultStatus.Type;

/** A login's new values, as `vault.save` takes them. */
export const CredentialDraft = Schema.Struct({
  name: Label,
  origins: CredentialOrigins,
  username: CredentialUsername,
  password: CredentialPassword,
  totp: Schema.NullOr(TotpSetup),
});
export type CredentialDraft = typeof CredentialDraft.Type;

/** A TOTP code now, and when it stops being valid. */
export const TotpPreview = Schema.Struct({
  code: Schema.Redacted(Schema.String),
  validUntil: Schema.DateTimeUtc,
});
export type TotpPreview = typeof TotpPreview.Type;
