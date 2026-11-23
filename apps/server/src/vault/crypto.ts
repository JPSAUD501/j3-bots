// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- scrypt and AES-256-GCM come only from node:crypto; Effect has neither.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// The vault's cryptography (docs/architecture/server.md, "The vault"):
//
// - the master password gives a key-encryption key through scrypt, with a
//   random salt and the parameters the keyring records;
// - that key wraps a random 256-bit data key with AES-256-GCM, so changing
//   the password only wraps the same data key again;
// - the data key seals every value with AES-256-GCM, a random 96-bit nonce
//   per value, and the value's record id and field name as associated data,
//   so a sealed value cannot be moved to another record or field.
//
// The password is checked by unwrapping the data key: a wrong one fails
// GCM's authentication. Nothing else derived from it is stored.

/** scrypt's cost parameters, as the keyring records them. */
export interface KdfParams {
  /** CPU and memory cost: a power of two. */
  readonly n: number;
  /** Block size. */
  readonly r: number;
  /** Parallelism. */
  readonly p: number;
}

/**
 * The parameters a new keyring gets. N = 2^16 with r = 8 takes 64 MiB and
 * about 0.7 s on a Raspberry Pi 4 (Verified, Node 24 on a Pi 4 Model B, against
 * 1.25 s for 2^17), and well under that on a desktop: once per unlock, which
 * also makes each guess at the password cost that much.
 */
export const KDF_PARAMS: KdfParams = { n: 2 ** 16, r: 8, p: 1 };

/** Every key here: AES-256. */
export const KEY_BYTES = 32;
/** GCM's nonce, random per value. */
export const NONCE_BYTES = 12;
/** The scrypt salt. */
export const SALT_BYTES = 16;
const TAG_BYTES = 16;

/** scrypt's memory for `params`, with room to spare: Node refuses past `maxmem`. */
const maxmemOf = (params: KdfParams) => 128 * params.n * params.r * params.p + 32 * 1024 * 1024;

/** The most memory scrypt may take for a keyring read from the file: 256 MiB. */
const MAX_KDF_MEMORY = 256 * 1024 * 1024;

/**
 * Whether a keyring's scrypt parameters are ones this release derives a key
 * with: N a power of two from 2^14 to 2^20, r from 1 to 32, p from 1 to 16,
 * and at most `MAX_KDF_MEMORY` in all. A file that asks for more is refused
 * rather than left to take the server's memory or time.
 */
export const kdfParamsInRange = ({ n, r, p }: KdfParams): boolean =>
  Number.isSafeInteger(n) &&
  Number.isSafeInteger(r) &&
  Number.isSafeInteger(p) &&
  n >= 2 ** 14 &&
  n <= 2 ** 20 &&
  (n & (n - 1)) === 0 &&
  r >= 1 &&
  r <= 32 &&
  p >= 1 &&
  p <= 16 &&
  128 * n * r * p <= MAX_KDF_MEMORY;

/** Text the data key's wrapping and every sealed value are bound to, so neither passes for the other. */
const DATA_KEY_AAD = Buffer.from("j3-bots vault v1\0data-key", "utf8");

/** What a value is bound to: its record and its field. NUL never appears in either. */
const fieldAad = (recordId: string, field: string) =>
  Buffer.from(`j3-bots vault v1\0${recordId}\0${field}`, "utf8");

/** A value sealed with AES-256-GCM: the nonce, and the ciphertext followed by its tag. */
export interface Sealed {
  readonly nonce: Uint8Array;
  readonly sealed: Uint8Array;
}

/**
 * The key-encryption key for `password`. The password is normalized (NFC),
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
 * Runs `use` with the key-encryption key for `password`, and zeroes the key
 * once `use` ends: done, failed or interrupted. Deriving it is not
 * interrupted: an interruption waits for scrypt, then zeroes what it gave.
 */
export const withDerivedKey = <A, E, R>(
  password: Redacted.Redacted<string>,
  salt: Uint8Array,
  params: KdfParams,
  use: (kek: Buffer) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(deriveKey(password, salt, params), use, (kek) =>
    Effect.sync(() => kek.fill(0)),
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

/** The data key wrapped by `kek`, under `nonce`. */
export const wrapDataKey = (kek: Uint8Array, dataKey: Uint8Array, nonce: Uint8Array): Sealed => ({
  nonce,
  sealed: encrypt(kek, nonce, DATA_KEY_AAD, dataKey),
});

/** The data key, or none when `kek` is not the key it was wrapped with: a wrong password. */
export const unwrapDataKey = (kek: Uint8Array, wrapped: Sealed): Option.Option<Buffer> =>
  Option.filter(decrypt(kek, wrapped.nonce, DATA_KEY_AAD, wrapped.sealed), (key) => {
    if (key.length === KEY_BYTES) return true;
    key.fill(0);
    return false;
  });

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
