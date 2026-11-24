// SPDX-License-Identifier: AGPL-3.0-or-later
import { rawPublicKey, type SignatureCheck } from "@j3-bots/release";
import { ed25519 } from "@noble/curves/ed25519.js";
import * as Result from "effect/Result";

// The phone's Ed25519 check of a release's SHA256SUMS. Android has Ed25519
// only from Android 13 and Hermes has no `node:crypto`, so it is
// @noble/curves, in JavaScript; the APK's SHA-256 is Android's own
// (modules/app-update).

/**
 * The check for `pems`: true when any one of the keys signed `message`, as
 * RFC 8032 has it, as OpenSSL and Node check it, so a signature they refuse is
 * refused here too. A PEM that is not an Ed25519 public key throws now rather
 * than refuse every release later.
 */
export const signatureCheck = (pems: ReadonlyArray<string>): SignatureCheck => {
  const keys = pems.map((pem) =>
    Result.getOrThrowWith(
      rawPublicKey(pem),
      (problem) => new TypeError(`Release key: ${problem}.`),
    ),
  );
  return (message, signature) =>
    keys.some((key) => {
      try {
        return ed25519.verify(signature, message, key, { zip215: false });
      } catch {
        return false;
      }
    });
};
