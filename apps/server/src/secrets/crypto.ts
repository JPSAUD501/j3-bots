// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- scrypt and AES-256-GCM come only from node:crypto; Effect has neither.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// The secrets' cryptography (docs/architecture/server.md, "Secrets"):
//
// - a random 256-bit data key, which the server keeps in its key file, seals
//   every value with AES-256-GCM, a random 96-bit nonce per value, and the
//   value's record id and field name as associated data, so a sealed value
//   cannot be moved to another record or field;
// - an export seals its copy under a key scrypt derives from the export's
//   passphrase, with a random salt and the parameters the archive records;
// - a subkey for one use of the data key's own, such as the browser's
//   sign-ins, which HKDF-SHA256 derives from the data key and the use's name,
//   so what one use seals no other opens.
//
// The associated data still says "vault": values sealed before secrets keep
// opening under it.

/** scrypt's cost parameters, as an archive records them. */
export interface KdfParams {
  /** CPU and memory cost: a power of two. */
  readonly n: number;
  /** Block size. */
  readonly r: number;
  /** Parallelism. */
  readonly p: number;
}

/** The cheapest parameters `kdfParamsInRange` accepts. */
const LEAST_KDF_PARAMS: KdfParams = { n: 2 ** 14, r: 1, p: 1 };

/** Every key here: AES-256. */
export const KEY_BYTES = 32;
/** GCM's nonce, random per value. */
export const NONCE_BYTES = 12;
/** The scrypt salt. */
export const SALT_BYTES = 16;
const TAG_BYTES = 16;

/** scrypt's memory for `params`, with room to spare: Node refuses past `maxmem`. */
const maxmemOf = (params: KdfParams) => 128 * params.n * params.r * params.p + 32 * 1024 * 1024;

/** The most memory scrypt may take for parameters read from an archive: 256 MiB. */
const MAX_KDF_MEMORY = 256 * 1024 * 1024;

/**
 * Whether an archive's scrypt parameters are ones this release derives a key
 * with: N a power of two from 2^14 to 2^20, r from 1 to 32, p from 1 to 16,
 * and at most `MAX_KDF_MEMORY` in all. A file that asks for more is refused
 * rather than left to take the server's memory or time.
 */
export const kdfParamsInRange = ({ n, r, p }: KdfParams): boolean =>
  Number.isSafeInteger(n) &&
  Number.isSafeInteger(r) &&
  Number.isSafeInteger(p) &&
  n >= LEAST_KDF_PARAMS.n &&
  n <= 2 ** 20 &&
  (n & (n - 1)) === 0 &&
  r >= LEAST_KDF_PARAMS.r &&
  r <= 32 &&
  p >= LEAST_KDF_PARAMS.p &&
  p <= 16 &&
  128 * n * r * p <= MAX_KDF_MEMORY;

/** What a subkey is for: each a key of its own. */
export type SubkeyPurpose = "browser-sign-ins";

/** The subkey of `dataKey` for `purpose`, which the caller zeroes when done with it. */
export const deriveSubkey = (dataKey: Uint8Array, purpose: SubkeyPurpose): Buffer =>
  Buffer.from(
    NodeCrypto.hkdfSync("sha256", dataKey, new Uint8Array(0), `j3-bots ${purpose} v1`, KEY_BYTES),
  );

/** What a value is bound to: its record and its field. NUL never appears in either. */
const fieldAad = (recordId: string, field: string) =>
  Buffer.from(`j3-bots vault v1\0${recordId}\0${field}`, "utf8");

/** A value sealed with AES-256-GCM: the nonce, and the ciphertext followed by its tag. */
export interface Sealed {
  readonly nonce: Uint8Array;
  readonly sealed: Uint8Array;
}

/**
 * The key `password` gives. The password is normalized (NFC),
 * so the same characters typed on two systems give the same key. The copy of
 * it made here is zeroed once scrypt has it; the string itself cannot be.
 */
const deriveKey = (
  password: Redacted.Redacted<string>,
  salt: Uint8Array,
  params: KdfParams,
): Effect.Effect<Buffer> =>
  Effect.callback<Buffer>((resume) => {
    const secret = Buffer.from(Redacted.value(password).normalize("NFC"), "utf8");
    NodeCrypto.scrypt(
      secret,
      salt,
      KEY_BYTES,
      { N: params.n, r: params.r, p: params.p, maxmem: maxmemOf(params) },
      (error, key) => {
        secret.fill(0);
        resume(error === null ? Effect.succeed(key) : Effect.die(error));
      },
    );
  });

/**
 * Runs `use` with the key `password` gives, and zeroes the key
 * once `use` ends: done, failed or interrupted. Deriving it is not
 * interrupted: an interruption waits for scrypt, then zeroes what it gave.
 */
export const withDerivedKey = <A, E, R>(
  password: Redacted.Redacted<string>,
  salt: Uint8Array,
  params: KdfParams,
  use: (key: Buffer) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(deriveKey(password, salt, params), use, (key) =>
    Effect.sync(() => key.fill(0)),
  );

const encrypt = (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array) => {
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
};

/** The plaintext, or none when the key, the nonce, the associated data or the bytes are not the ones sealed. */
const decrypt = (
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
): Option.Option<Buffer> => {
  if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) return Option.none();
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const body = decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES));
  try {
    const rest = decipher.final();
    const plain = Buffer.concat([body, rest]);
    rest.fill(0);
    return Option.some(plain);
  } catch {
    // `final` throws when authentication fails, which is the answer here.
    return Option.none();
  } finally {
    body.fill(0);
  }
};

/** `plain`, sealed for `field` of record `recordId`. */
export const sealField = (
  dataKey: Uint8Array,
  recordId: string,
  field: string,
  plain: Uint8Array,
  nonce: Uint8Array,
): Sealed => ({ nonce, sealed: encrypt(dataKey, nonce, fieldAad(recordId, field), plain) });

/**
 * A field's plaintext, or none when it was sealed under another key, for
 * another record or field, or changed since.
 */
export const openField = (
  dataKey: Uint8Array,
  recordId: string,
  field: string,
  value: Sealed,
): Option.Option<Buffer> => decrypt(dataKey, value.nonce, fieldAad(recordId, field), value.sealed);
