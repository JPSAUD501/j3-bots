// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OpenResult, SealResult } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { safeStorage } from "electron";
import { protectionOf } from "./protection.ts";

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

/** Whether the system's encryption, the one the calls below use, can be used now. */
const available = () => safeStorage.isAsyncEncryptionAvailable().catch(() => false);

/**
 * Seals and opens the device token with Electron's `safeStorage`, which
 * encrypts with a key the system keeps: the Keychain on macOS, DPAPI on
 * Windows, a secret service on Linux. The page stores what is sealed; only
 * this profile, on this machine, opens it. Called after the app is ready.
 *
 * On Linux with no secret service the app can use, `safeStorage` encrypts
 * with a key built into Chromium, which only obscures the token. The app
 * still pairs there rather than refuse, and says so: what it sealed that way
 * is `unencrypted`. Where the system will not encrypt at all, sealing fails,
 * and so does the save.
 */
export const makeTokenSeal = () => {
  const seal = (token: string): Effect.Effect<SealResult> =>
    Effect.promise(async (): Promise<SealResult> => {
      if (!(await available())) return { _tag: "failed" };
      return safeStorage.encryptStringAsync(encodePayload({ token })).then(
        (sealed): SealResult => ({
          _tag: "sealed",
          sealed: sealed.toString("base64"),
          protection: protectionOf(sealed, process.platform),
        }),
        (): SealResult => ({ _tag: "failed" }),
      );
    });

  // A rejection says the system would not decrypt it now, not that it is not
  // the app's: a locked keyring rejects as a key that is gone does.
  const open = (sealed: string): Effect.Effect<OpenResult> =>
    Effect.promise(async (): Promise<OpenResult> => {
      if (!(await available())) return { _tag: "unavailable" };
      return safeStorage.decryptStringAsync(Buffer.from(sealed, "base64")).then(
        ({ result, shouldReEncrypt }) =>
          Option.match(decodePayload(result), {
            onNone: (): OpenResult => ({ _tag: "failed" }),
            onSome: ({ token }): OpenResult => ({ _tag: "opened", token, stale: shouldReEncrypt }),
          }),
        (): OpenResult => ({ _tag: "unavailable" }),
      );
    });

  return { seal, open } as const;
};
