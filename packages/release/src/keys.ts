// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

/**
 * A public key that signs J3 Bots releases: its `SHA256SUMS.sig` is this
 * key's Ed25519 signature over the release's `SHA256SUMS`.
 */
export interface ReleaseKey {
  /** What names the key where people read about it, such as the year it was made. */
  readonly id: string;
  /** The key as SubjectPublicKeyInfo PEM, as `openssl pkey -pubout` writes it. */
  readonly pem: string;
}

/**
 * The keys a release may be signed with. A release verifies when any one of
 * them signed it, so a new key is added here a release before the old one
 * stops signing (docs/operations/releasing.md, "The release key"). The
 * private key is the `RELEASE_SIGNING_KEY` secret of the `release-signing`
 * environment, which only a release tag's job can read, and an offline copy.
 */
export const RELEASE_KEYS: ReadonlyArray<ReleaseKey> = [
  {
    id: "2026",
    pem: [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAnL4CWfO6teDA5jgo0VoeOOnrxy5a7R3y0DNeJeCRDfg=",
      "-----END PUBLIC KEY-----",
    ].join("\n"),
  },
];

/** What every Ed25519 SubjectPublicKeyInfo holds before its 32 key bytes. */
const ED25519_SPKI_PREFIX = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/**
 * The 32 raw bytes of an Ed25519 public key in PEM, for a verifier that takes
 * the key itself rather than PEM, such as a phone's; a failure for a PEM that
 * is not one Ed25519 public key.
 */
export const rawPublicKey = (pem: string): Result.Result<Uint8Array, string> => {
  const body = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");
  return Result.flatMap(
    Result.mapError(Base64.decode(body), () => "not base64"),
    (der) =>
      der.length === ED25519_SPKI_PREFIX.length + 32 &&
      ED25519_SPKI_PREFIX.every((byte, index) => der[index] === byte)
        ? Result.succeed(der.slice(ED25519_SPKI_PREFIX.length))
        : Result.fail("not an Ed25519 public key"),
  );
};
