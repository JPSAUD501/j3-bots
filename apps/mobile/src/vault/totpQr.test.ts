// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { totpAddressOf } from "./totpQr.ts";

describe("totpAddressOf", () => {
  it("takes the address a site's two-step QR code carries", () => {
    const address =
      "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";
    expect(totpAddressOf(` ${address}\n`)).toEqual(Option.some(address));
    expect(Option.isSome(totpAddressOf("OTPAUTH://TOTP/x?secret=JBSWY3DPEHPK3PXP"))).toBe(true);
  });

  it("refuses every other code", () => {
    for (const data of [
      "otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=1",
      "otpauth://totp/Example:alice?issuer=Example",
      "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8",
      "https://example.com/?secret=JBSWY3DPEHPK3PXP",
      "j3bots://pair?server=https%3A%2F%2Fexample.com&code=ABCDE12345",
      "JBSWY3DPEHPK3PXP",
    ]) {
      expect(totpAddressOf(data)).toEqual(Option.none());
    }
  });
});
