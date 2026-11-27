// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 of a harness or a screen recording of hundreds of MB needs an incremental hash; Effect has none.
import * as NodeCrypto from "node:crypto";

/** An incremental SHA-256, for a file read in chunks. */
export interface Sha256 {
  readonly update: (chunk: Uint8Array) => void;
  /** The lowercase hex digest of everything given so far; the hash cannot be used after. */
  readonly hex: () => string;
}

export const sha256 = (): Sha256 => {
  const hash = NodeCrypto.createHash("sha256");
  return { update: (chunk) => void hash.update(chunk), hex: () => hash.digest("hex") };
};

/** The lowercase hex SHA-256 of `bytes`. */
export const sha256Hex = (bytes: Uint8Array): string => {
  const hash = sha256();
  hash.update(bytes);
  return hash.hex();
};
