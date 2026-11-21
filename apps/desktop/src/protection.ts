// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TokenProtection } from "@j3-bots/desktop-bridge";

/**
 * The versions Chromium writes on Linux before what it sealed with a key a
 * keyring keeps (**Read** in Chromium 152.0.7977.169, the one Electron
 * 44.10.1 ships, `components/os_crypt/async/browser/`): `v11` with the
 * Secret Service's (`freedesktop_secret_key_provider.cc`: GNOME Keyring,
 * KWallet), `v12` with the Secret Portal's (`secret_portal_key_provider.h`).
 */
const KEYRING_VERSIONS = new Set(["v11", "v12"]);

/** Chromium's versions are three ASCII characters. */
const VERSION_LENGTH = 3;

/**
 * How `sealed`, as `safeStorage` just sealed it on `platform`, is kept. On
 * Linux only a keyring's version counts as encrypted; anything else, `v10`
 * with the key built into Chromium (`posix_key_provider.cc`) or a version
 * this list does not know, counts as only obscured, so the notice errs on
 * the side of saying so.
 */
export const protectionOf = (sealed: Uint8Array, platform: NodeJS.Platform): TokenProtection =>
  platform !== "linux" ||
  KEYRING_VERSIONS.has(Buffer.from(sealed.subarray(0, VERSION_LENGTH)).toString("latin1"))
    ? "encrypted"
    : "unencrypted";
