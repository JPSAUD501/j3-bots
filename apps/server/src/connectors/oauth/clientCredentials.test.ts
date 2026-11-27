// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the keys a service hands an operator are made here with node:crypto, as a service makes them.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { signingKeyOf } from "./clientCredentials.ts";

const algorithms = (text: string) =>
  Option.map(signingKeyOf(text), (key) => key.algorithms).pipe(Option.getOrNull);

const ec = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

it("takes a private key pasted whole, on one line, or with its line breaks written out", () => {
  assert.deepStrictEqual(algorithms(pem), ["ES256"]);
  // A one-line field takes a pasted key with its line breaks gone, or written as `\n`.
  assert.deepStrictEqual(algorithms(pem.replaceAll("\n", " ")), ["ES256"]);
  assert.deepStrictEqual(algorithms(pem.replaceAll("\n", "")), ["ES256"]);
  assert.deepStrictEqual(algorithms(pem.replaceAll("\n", "\\n")), ["ES256"]);
});

it("takes a private key as a JWK", () => {
  const jwk = JSON.stringify(
    NodeCrypto.generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
  );
  assert.deepStrictEqual(algorithms(jwk), ["EdDSA"]);
});

it("refuses a public key, an RSA key too short to sign with, and what is no key", () => {
  assert.isNull(algorithms(ec.publicKey.export({ type: "spki", format: "pem" }).toString()));
  const short = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  assert.isNull(algorithms(short.privateKey.export({ type: "pkcs8", format: "pem" }).toString()));
  const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.deepStrictEqual(
    algorithms(privateKey.export({ type: "pkcs1", format: "pem" }).toString()),
    ["RS256", "PS256"],
  );
  assert.isNull(algorithms("not a key"));
  assert.isNull(algorithms('{"kty":"oct","k":"c2VjcmV0"}'));
});
