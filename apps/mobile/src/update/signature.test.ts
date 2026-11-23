// SPDX-License-Identifier: AGPL-3.0-or-later
import { checkDigest, RELEASE_KEYS, verifySums } from "@j3-bots/release";
import { sha256 } from "@j3-bots/release/node";
import { TEST_PUBLIC_KEY, VERIFICATION_CASES } from "@j3-bots/release/testing";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { signatureCheck } from "./signature.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (text: string) => {
  const hash = sha256();
  hash.update(bytes(text));
  return hash.hex();
};

// The same cases the server and the desktop app run, through the phone's own
// Ed25519 check: a signature Node accepts or refuses, the phone does too.
describe("the phone's check of a release's signed checksums", () => {
  const check = signatureCheck([TEST_PUBLIC_KEY]);

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
      expect(outcome).toBe(testCase.expect);
    });
  }

  it("refuses a release the test key signed when only the release keys are trusted", () => {
    const [good] = VERIFICATION_CASES;
    if (good?.signature == null) throw new Error("The first case is a signed release.");
    const verified = verifySums({
      version: good.version,
      sums: bytes(good.sums),
      signature: bytes(good.signature),
      check: signatureCheck(RELEASE_KEYS.map((key) => key.pem)),
    });
    expect(verified).toEqual(Result.fail("signature-invalid"));
  });
});
