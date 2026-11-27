// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- node:net's isIPv6 is the only full IPv6 grammar at hand; Effect has none.
import * as NodeNet from "node:net";
import * as Redacted from "effect/Redacted";

// The one scrubber every text file of a diagnostics zip goes through before it
// enters the zip (docs/decisions/0100-…). What it replaces, in this order, so
// a value is never half-replaced by a later, broader rule:
//
// 1. the exact values the server holds as secrets, and the keys it knows
//    (`ScrubContext.secrets`), as they are and as JSON writes them;
// 2. credentials in a URL, and bearer and basic authorization;
// 3. token-shaped strings: JWTs, the prefixes of known services' tokens, and
//    long runs of hex or of mixed-case base64;
// 4. email addresses;
// 5. the home directory, as `~`; then the OS user name and the host name;
// 6. IPv4 and IPv6 addresses, but loopback and the unspecified address,
//    which say nothing of the machine or its network.
//
// Ids of bots, rooms, conversations and the rest are random and stay, so a
// flow can be followed across files: lowercase base32 behind a short prefix,
// none of them long enough to look like a token.

/** What the scrubber needs to know of this machine and this server. */
export interface ScrubContext {
  /**
   * The values to remove wherever they appear: every value in the secret
   * store, a connector's tokens and headers, the engine's credential. One
   * shorter than `MIN_SECRET_LENGTH` is left to the other rules: replacing
   * every "abc" in a log would hide more than it protects.
   */
  readonly secrets: ReadonlyArray<Redacted.Redacted<string>>;
  /** The OS user's home directory, as the system gives it. */
  readonly home: string;
  /** The OS user's name. */
  readonly user: string;
  /** The machine's host name. */
  readonly host: string;
}

/** The shortest secret value replaced as such. */
export const MIN_SECRET_LENGTH = 4;

/** The shortest user or host name replaced on its own: shorter ones are too common a word. */
const MIN_NAME_LENGTH = 3;

/** What each kind of value becomes. */
export const PLACEHOLDERS = {
  secret: "[secret]",
  token: "[token]",
  credentials: "[credentials]",
  email: "[email]",
  user: "[user]",
  host: "[host]",
  ipv4: "[ipv4]",
  ipv6: "[ipv6]",
} as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `value` as it appears inside a JSON string: what a JSON log line holds. */
const asJsonString = (value: string) => JSON.stringify(value).slice(1, -1);

/** Every form of `value` a text file may hold it in, longest first. */
const formsOf = (value: string): ReadonlyArray<string> => {
  const json = asJsonString(value);
  return json === value ? [value] : [json, value];
};

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi;
const AUTHORIZATION = /\b(Bearer|Basic|Token)(\s+|%20)[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
/** Prefixes known services give their tokens and keys. */
const PREFIXED_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|phc_[A-Za-z0-9]{16,}|phx_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,})/g;
/** 32 hex digits or more: a key, a hash or a token. */
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
/**
 * 32 characters or more of base64, with an upper and a lower case letter and
 * a digit. Without `/`, so a path is never one run: a standard base64 value
 * with slashes in it still leaves runs this long.
 */
const LONG_BASE64 = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const isMixedBase64 = (run: string) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const IPV6_CANDIDATE = /(?<![0-9A-Za-z:.])[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?![0-9A-Za-z:])/g;

const KEPT_IPV4 = new Set(["127.0.0.1", "0.0.0.0"]);
const KEPT_IPV6 = new Set(["::1", "::"]);

/**
 * A word in a path or a sentence: `name` not inside a longer run of letters,
 * digits, `-` or `_`, case aside, as a user or host name stands in a log.
 */
const wordPattern = (name: string) =>
  new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`, "gi");

/** The home directory in each form a log may hold it: as given, with `/`, and JSON-escaped. */
const homeForms = (home: string): ReadonlyArray<string> => {
  const trimmed = home.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return [];
  const forms = new Set([trimmed, trimmed.replace(/\\/g, "/")]);
  for (const form of [...forms]) forms.add(asJsonString(form));
  return [...forms].sort((a, b) => b.length - a.length);
};

/** The scrubber for `context`: text in, the same text with nothing of the person in it. */
export const makeScrubber = (context: ScrubContext): ((text: string) => string) => {
  const secrets = [
    ...new Set(
      context.secrets
        .map(Redacted.value)
        .filter((value) => value.length >= MIN_SECRET_LENGTH)
        .flatMap(formsOf),
    ),
  ].sort((a, b) => b.length - a.length);
  const secretPattern =
    secrets.length === 0 ? null : new RegExp(secrets.map(escapeRegExp).join("|"), "g");
  const homes = homeForms(context.home);
  const homePattern =
    homes.length === 0
      ? null
      : new RegExp(`${homes.map(escapeRegExp).join("|")}(?![A-Za-z0-9_-])`, "gi");
  const names: ReadonlyArray<readonly [RegExp, string]> = [
    ...(context.host.length >= MIN_NAME_LENGTH
      ? [[wordPattern(context.host), PLACEHOLDERS.host] as const]
      : []),
    ...(context.user.length >= MIN_NAME_LENGTH
      ? [[wordPattern(context.user), PLACEHOLDERS.user] as const]
      : []),
  ];

  return (text) => {
    let out = secretPattern === null ? text : text.replace(secretPattern, PLACEHOLDERS.secret);
    out = out
      .replace(URL_CREDENTIALS, `$1${PLACEHOLDERS.credentials}@`)
      .replace(AUTHORIZATION, `$1$2${PLACEHOLDERS.token}`)
      .replace(JWT, PLACEHOLDERS.token)
      .replace(PREFIXED_TOKEN, PLACEHOLDERS.token)
      .replace(LONG_HEX, PLACEHOLDERS.token)
      .replace(LONG_BASE64, (run) => (isMixedBase64(run) ? PLACEHOLDERS.token : run))
      .replace(EMAIL, PLACEHOLDERS.email);
    if (homePattern !== null) out = out.replace(homePattern, "~");
    for (const [pattern, placeholder] of names) out = out.replace(pattern, placeholder);
    return out
      .replace(IPV4, (address) => (KEPT_IPV4.has(address) ? address : PLACEHOLDERS.ipv4))
      .replace(IPV6_CANDIDATE, (candidate) =>
        NodeNet.isIPv6(candidate) && !KEPT_IPV6.has(candidate.toLowerCase())
          ? PLACEHOLDERS.ipv6
          : candidate,
      );
  };
};
