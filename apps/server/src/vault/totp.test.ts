// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { decodeBase32, hotp, parseTotpSetup, type TotpAlgorithm, totpAt } from "./totp.ts";

const ascii = (text: string) => new TextEncoder().encode(text);

/** `bytes` in base32, as a site would show the secret. */
const base32 = (bytes: Uint8Array) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  let text = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += alphabet[(buffer >> bits) & 31];
    }
  }
  return bits > 0 ? text + alphabet[(buffer << (5 - bits)) & 31] : text;
};

describe("one-time codes", () => {
  it("gives RFC 4226's HOTP values (Appendix D)", () => {
    const key = ascii("12345678901234567890");
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    assert.deepStrictEqual(
      expected.map((_, counter) => hotp(key, BigInt(counter), 6, "SHA1")),
      expected,
    );
  });

  it("gives RFC 6238's TOTP values for every algorithm (Appendix B)", () => {
    const seeds: Record<TotpAlgorithm, string> = {
      SHA1: "12345678901234567890",
      SHA256: "12345678901234567890123456789012",
      SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
    };
    const vectors: ReadonlyArray<readonly [number, TotpAlgorithm, string]> = [
      [59, "SHA1", "94287082"],
      [59, "SHA256", "46119246"],
      [59, "SHA512", "90693936"],
      [1111111109, "SHA1", "07081804"],
      [1111111109, "SHA256", "68084774"],
      [1111111109, "SHA512", "25091201"],
      [1111111111, "SHA1", "14050471"],
      [1111111111, "SHA256", "67062674"],
      [1111111111, "SHA512", "99943326"],
      [1234567890, "SHA1", "89005924"],
      [1234567890, "SHA256", "91819424"],
      [1234567890, "SHA512", "93441116"],
      [2000000000, "SHA1", "69279037"],
      [2000000000, "SHA256", "90698825"],
      [2000000000, "SHA512", "38618901"],
      [20000000000, "SHA1", "65353130"],
      [20000000000, "SHA256", "77737706"],
      [20000000000, "SHA512", "47863826"],
    ];
    for (const [time, algorithm, code] of vectors) {
      const config = {
        secret: base32(ascii(seeds[algorithm])),
        algorithm,
        digits: 8 as const,
        period: 30,
      };
      assert.deepStrictEqual(
        totpAt(config, time),
        Option.some({ code, nextAt: (Math.floor(time / 30) + 1) * 30 }),
      );
    }
  });

  it("reads a secret as authenticator apps do, and refuses one too short or not base32", () => {
    assert.deepStrictEqual(decodeBase32("mzxw 6ytb-oi======"), Option.some(ascii("foobar")));
    assert.deepStrictEqual(decodeBase32("MZXW1"), Option.none());
    assert.deepStrictEqual(
      parseTotpSetup("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"),
      Option.some({
        secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      }),
    );
    // 75 bits: shorter than any authenticator app takes.
    assert.deepStrictEqual(parseTotpSetup("GEZDGNBVGY3TQOJ"), Option.none());
  });

  it("takes an otpauth://totp address with its own settings, and no other kind", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    assert.deepStrictEqual(
      parseTotpSetup(
        `otpauth://totp/Example:ana@example.com?secret=${secret.toLowerCase()}&issuer=Example&algorithm=SHA256&digits=8&period=60`,
      ),
      Option.some({ secret, algorithm: "SHA256", digits: 8, period: 60 }),
    );
    assert.deepStrictEqual(
      parseTotpSetup(`otpauth://totp/Example?secret=${secret}`),
      Option.some({ secret, algorithm: "SHA1", digits: 6, period: 30 }),
    );
    for (const refused of [
      `otpauth://hotp/Example?secret=${secret}&counter=1`,
      `otpauth://totp/Example?secret=${secret}&algorithm=MD5`,
      "otpauth://totp/Example?issuer=Example",
    ]) {
      assert.deepStrictEqual(parseTotpSetup(refused), Option.none());
    }
  });
});
