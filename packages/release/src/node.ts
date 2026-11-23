// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Ed25519 and an incremental SHA-256 of a large file need node:crypto; Effect has neither.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { RELEASE_KEYS, type ReleaseKey } from "./keys.ts";
import type { SignatureCheck } from "./verify.ts";

// The release checks' primitives on Node, for the server and the desktop
// app's main process. Nothing else in this package imports Node.

/**
 * The signature check for `keys`: true when any one of them signed. The keys
 * are read once, here, so a key that is not an Ed25519 public key throws now
 * rather than refuse every release later.
 */
export const signatureCheck = (keys: ReadonlyArray<ReleaseKey> = RELEASE_KEYS): SignatureCheck => {
  const publicKeys = keys.map((key) => {
    const publicKey = NodeCrypto.createPublicKey(key.pem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`Release key ${key.id} is not an Ed25519 public key.`);
    }
    return publicKey;
  });
  return (message, signature) =>
    publicKeys.some((publicKey) => {
      try {
        return NodeCrypto.verify(null, message, publicKey, signature);
      } catch {
        return false;
      }
    });
};

/** A SHA-256 fed in pieces, as a download arrives: `update` each chunk, then `hex` once. */
export interface Sha256 {
  readonly update: (chunk: Uint8Array) => void;
  readonly hex: () => string;
}

export const sha256 = (): Sha256 => {
  const hash = NodeCrypto.createHash("sha256");
  return { update: (chunk) => void hash.update(chunk), hex: () => hash.digest("hex") };
};

/** The SHA-256 of the file at `path`, lowercase hex, read as a stream. */
export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = sha256();
    NodeFS.createReadStream(path)
      .on("data", (chunk) => hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.hex()));
  });
