// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";

/**
 * The `otpauth://totp/` address a site's QR code carries when two-step
 * sign-in is turned on, as read; none for any other code, a counter-based
 * `otpauth://hotp/` one included. Only its shape is checked here: the server
 * checks the key and its settings when the login is saved.
 */
export const totpAddressOf = (data: string): Option.Option<string> => {
  const read = data.trim();
  if (!URL.canParse(read)) return Option.none();
  const url = new URL(read);
  return url.protocol === "otpauth:" &&
    url.host.toLowerCase() === "totp" &&
    (url.searchParams.get("secret") ?? "") !== ""
    ? Option.some(read)
    : Option.none();
};
