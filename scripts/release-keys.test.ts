// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- reads the repository's files and parses keys with node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// The public keys a release's SHA256SUMS may be signed with are the files in
// release-keys/. Whatever checks a signature and cannot read them at run time
// carries a copy of the same PEM text, listed here.

const ROOT = NodePath.join(import.meta.dirname, "..");
const KEYS = NodePath.join(ROOT, "release-keys");

/** The files that carry a copy of every release key, as PEM blocks in their text. */
const EMBEDDED = ["scripts/install.sh", "packages/release/src/keys.ts"];

const PEM = /-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+?\n-----END PUBLIC KEY-----/g;

const releaseKeys = () =>
  NodeFS.readdirSync(KEYS)
    .filter((name) => name.endsWith(".pem"))
    .map((name) => NodeFS.readFileSync(NodePath.join(KEYS, name), "utf8").trimEnd());

describe("the release keys", () => {
  it("are Ed25519 public keys, one per file", () => {
    const keys = releaseKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.match(PEM)).toEqual([key]);
      expect(NodeCrypto.createPublicKey(key).asymmetricKeyType).toBe("ed25519");
    }
  });

  it.each(EMBEDDED)("are the keys %s carries", (file) => {
    const text = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");
    expect([...(text.match(PEM) ?? [])].sort()).toEqual(releaseKeys().sort());
  });
});
