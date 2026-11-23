// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- signs test lists with a key made for the run.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { TEST_PUBLIC_KEY, VERIFICATION_CASES } from "../testing/vectors.ts";
import { RELEASE_KEYS, rawPublicKey } from "./keys.ts";
import { sha256, signatureCheck } from "./node.ts";
import { checkDigest, VerifiedSums, verifySums } from "./verify.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (text: string) => {
  const hash = sha256();
  hash.update(bytes(text));
  return hash.hex();
};

describe("a release's signed checksums", () => {
  const check = signatureCheck([{ id: "test", pem: TEST_PUBLIC_KEY }]);

  for (const testCase of VERIFICATION_CASES) {
    it(`ends ${testCase.expect} for ${testCase.name}`, () => {
      const verified = verifySums({
        version: testCase.version,
        sums: bytes(testCase.sums),
        signature: testCase.signature === null ? null : bytes(testCase.signature),
        check,
      });
      const outcome = Result.match(verified, {
        onFailure: (failure) => failure,
        onSuccess: (sums) =>
          Result.match(checkDigest(sums, testCase.file.name, digest(testCase.file.contents)), {
            onFailure: (failure) => failure,
            onSuccess: () => "verified" as const,
          }),
      });
      assert.strictEqual(outcome, testCase.expect);
    });
  }

  it("refuses a release signed with the test key once only the release keys are trusted", () => {
    const [good] = VERIFICATION_CASES;
    assert.isDefined(good);
    const verified = verifySums({
      version: good.version,
      sums: bytes(good.sums),
      signature: good.signature === null ? null : bytes(good.signature),
      check: signatureCheck(RELEASE_KEYS),
    });
    assert.deepStrictEqual(verified, Result.fail("signature-invalid"));
  });

  it("reads every release key as a 32-byte Ed25519 key", () => {
    for (const key of [...RELEASE_KEYS, { id: "test", pem: TEST_PUBLIC_KEY }]) {
      const raw = rawPublicKey(key.pem);
      assert.isTrue(Result.isSuccess(raw) && raw.success.length === 32, key.id);
    }
    assert.isTrue(
      Result.isFailure(rawPublicKey("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")),
    );
  });
});

describe("a signed list's lines", () => {
  // A key made for this run, so any bytes can be signed.
  const key = NodeCrypto.generateKeyPairSync("ed25519");
  const check = signatureCheck([
    { id: "run", pem: key.publicKey.export({ type: "spki", format: "pem" }).toString() },
  ]);
  const signed = (sums: string, signature = (bytes: Uint8Array) => bytes) =>
    verifySums({
      version: "0.3.1",
      sums: bytes(sums),
      signature: signature(
        bytes(`${NodeCrypto.sign(null, bytes(sums), key.privateKey).toString("base64")}\n`),
      ),
      check,
    });
  const line = (name: string) => `${"a".repeat(64)}  ${name}\n`;
  const anchor = line("j3-bots-0.3.1-linux-x64.tar.gz");

  it("takes the lines the release writes, each ending with a line feed", () => {
    assert.isTrue(Result.isSuccess(signed(anchor + line("install.sh"))));
  });

  for (const [name, sums] of [
    ["a blank line", `${anchor}\n${line("install.sh")}`],
    ["a carriage return", anchor.replace("\n", "\r\n")],
    ["a space after the name", anchor.replace("\n", " \n")],
    ["an uppercase digest", anchor.replace("a".repeat(64), "A".repeat(64))],
    ["a name in a folder", anchor + line("bin/j3-bots")],
    ["the parent folder's name", anchor + line("..")],
    ["the folder's own name", anchor + line(".")],
    ["a line in binary mode", anchor.replace("  ", " *")],
    ["a last line without its line feed", (anchor + line("install.sh")).trimEnd()],
    ["a name given twice", anchor + anchor],
    ["no line at all", ""],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.deepStrictEqual(signed(sums), Result.fail("checksums-malformed"));
    });
  }

  it("is made only by verifying", () => {
    const verified = signed(anchor);
    assert.isTrue(Result.isSuccess(verified) && verified.success instanceof VerifiedSums);
    // @ts-expect-error -- an object shaped like it is not one: its digests are a private field.
    const forged: VerifiedSums = { version: "0.3.1", digestOf: () => "a".repeat(64) };
    assert.isFalse(forged instanceof VerifiedSums);
  });

  it("refuses a signature file with anything around the signature", () => {
    const crlf = (signature: Uint8Array) =>
      bytes(new TextDecoder().decode(signature).replace("\n", "\r\n"));
    const twice = (signature: Uint8Array) => bytes(new TextDecoder().decode(signature).repeat(2));
    assert.deepStrictEqual(signed(anchor, crlf), Result.fail("signature-invalid"));
    assert.deepStrictEqual(signed(anchor, twice), Result.fail("signature-invalid"));
  });
});
