// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { TEST_PUBLIC_KEY, VERIFICATION_CASES } from "../testing/vectors.ts";
import { RELEASE_KEYS, rawPublicKey } from "./keys.ts";
import { sha256, signatureCheck } from "./node.ts";
import { checkDigest, verifySums } from "./verify.ts";

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
