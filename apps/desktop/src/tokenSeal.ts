// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OpenResult, SealResult, TokenProtection } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { safeStorage } from "electron";

/**
 * What is encrypted: the token in a payload of its own, so what decrypts is
 * read only if it is one. A wrong key on Linux and macOS (AES-CBC, no
 * authentication) can decrypt garbage without an error.
 */
const Payload = Schema.fromJsonString(
  Schema.Struct({ token: Schema.String.check(Schema.isMinLength(1)) }),
);
const encodePayload = Schema.encodeSync(Payload);
const decodePayload = Schema.decodeUnknownOption(Payload);

/**
 * Seals and opens the device token with Electron's `safeStorage`, which
 * encrypts with a key the system keeps: the Keychain on macOS, DPAPI on
 * Windows, a secret service on Linux. The page stores what is sealed; only
 * this profile, on this machine, opens it.
 *
 * On Linux with no secret service the app can use, `safeStorage` encrypts
 * with a key built into Chromium, which only obscures the token. The app
 * still pairs there rather than refuse, and says so: `protection` is then
 * `unencrypted`. Decided once, after the app is ready.
 */
export const makeTokenSeal = () => {
  const protection: TokenProtection =
    process.platform !== "linux" || safeStorage.isEncryptionAvailable()
      ? "encrypted"
      : "unencrypted";

  // Either call rejects when the system will not encrypt, or what is given
  // was not sealed with this profile's key.
  const seal = (token: string): Effect.Effect<SealResult> =>
    Effect.promise(() =>
      safeStorage.encryptStringAsync(encodePayload({ token })).then(
        (sealed): SealResult => ({ _tag: "sealed", sealed: sealed.toString("base64"), protection }),
        (): SealResult => ({ _tag: "failed" }),
      ),
    );

  const open = (sealed: string): Effect.Effect<OpenResult> =>
    Effect.promise(() =>
      safeStorage.decryptStringAsync(Buffer.from(sealed, "base64")).then(
        ({ result }) =>
          Option.match(decodePayload(result), {
            onNone: (): OpenResult => ({ _tag: "failed" }),
            onSome: ({ token }): OpenResult => ({ _tag: "opened", token }),
          }),
        (): OpenResult => ({ _tag: "failed" }),
      ),
    );

  return { protection, seal, open } as const;
};
