// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- HOTP is an HMAC, synchronous and over the secrets' own bytes; Effect's HMAC is asynchronous and needs a service.
import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// One-time codes: HOTP (RFC 4226) over a time counter (TOTP, RFC 6238), with
// the secret in base32 (RFC 4648) as sites give it.

export const TotpAlgorithm = Schema.Literals(["SHA1", "SHA256", "SHA512"]);
export type TotpAlgorithm = typeof TotpAlgorithm.Type;

/** A login's code generator, as the secrets seal it. */
export const TotpConfig = Schema.Struct({
  /** The secret in base32, upper case, without padding or spaces. */
  secret: Schema.String,
  algorithm: TotpAlgorithm,
  digits: Schema.Literals([6, 7, 8]),
  /** Seconds each code lasts. */
  period: Schema.Int.check(Schema.isBetween({ minimum: 15, maximum: 120 })),
});
export type TotpConfig = typeof TotpConfig.Type;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The bytes `text` encodes in base32, read as authenticator apps read a
 * typed secret: any case, spaces and dashes ignored, padding optional. None
 * for any other character.
 */
export const decodeBase32 = (text: string): Option.Option<Uint8Array> => {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const bytes: Array<number> = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value === -1) return Option.none();
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Option.some(Uint8Array.from(bytes));
};

/** The fewest bytes a secret may have: 80 bits, 16 base32 characters, as authenticator apps ask. */
const MIN_SECRET_BYTES = 10;

const normalizedSecret = (text: string): Option.Option<string> =>
  Option.flatMap(decodeBase32(text), (bytes) =>
    bytes.length >= MIN_SECRET_BYTES
      ? Option.some(text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase())
      : Option.none(),
  );

const ALGORITHMS: Readonly<Record<string, TotpAlgorithm>> = {
  SHA1: "SHA1",
  SHA256: "SHA256",
  SHA512: "SHA512",
};

const DIGITS: Readonly<Record<string, TotpConfig["digits"]>> = { "6": 6, "7": 7, "8": 8 };

/**
 * What the operator pasted, as a code generator: a base32 secret, with the
 * usual settings (SHA-1, six digits, 30 seconds), or an `otpauth://totp/`
 * address with its own. None for anything else, a counter-based
 * `otpauth://hotp/` address included.
 */
export const parseTotpSetup = (text: string): Option.Option<TotpConfig> => {
  const typed = text.trim();
  if (!/^otpauth:/i.test(typed)) {
    return Option.map(normalizedSecret(typed), (secret) => ({
      secret,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    }));
  }
  if (!URL.canParse(typed)) return Option.none();
  const url = new URL(typed);
  if (url.protocol !== "otpauth:" || url.host.toLowerCase() !== "totp") return Option.none();
  const query = url.searchParams;
  const algorithm = ALGORITHMS[(query.get("algorithm") ?? "SHA1").toUpperCase()];
  const digits = DIGITS[query.get("digits") ?? "6"];
  const periodText = query.get("period") ?? "30";
  const period = /^\d{1,3}$/.test(periodText) ? Number(periodText) : Number.NaN;
  if (algorithm === undefined || digits === undefined || !(period >= 15 && period <= 120)) {
    return Option.none();
  }
  return Option.map(normalizedSecret(query.get("secret") ?? ""), (secret) => ({
    secret,
    algorithm,
    digits,
    period,
  }));
};

const HMAC: Readonly<Record<TotpAlgorithm, string>> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
};

/** RFC 4226's code for `counter`, `digits` long, zero-padded. */
export const hotp = (
  key: Uint8Array,
  counter: bigint,
  digits: number,
  algorithm: TotpAlgorithm,
): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = NodeCrypto.createHmac(HMAC[algorithm], key).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
};

/** The code `config` gives at `epochSeconds`, and the second at which the next one starts. */
export const totpAt = (
  config: TotpConfig,
  epochSeconds: number,
): Option.Option<{ readonly code: string; readonly nextAt: number }> =>
  Option.map(decodeBase32(config.secret), (key) => {
    const step = Math.floor(epochSeconds / config.period);
    const code = hotp(key, BigInt(step), config.digits, config.algorithm);
    key.fill(0);
    return { code, nextAt: (step + 1) * config.period };
  });
