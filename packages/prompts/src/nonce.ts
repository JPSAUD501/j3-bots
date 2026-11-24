// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SecureRandom } from "effect/crypto";
import { foldForMatching } from "./text.ts";

/** A nonce's length in bytes: twelve hex characters. */
export const NONCE_BYTES = 6;
const NONCE_ATTEMPTS = 8;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The random source kept returning nonces that already occur in the text. */
class NonceUnavailable extends Schema.TaggedError<NonceUnavailable>()("NonceUnavailable", {}) {}

/**
 * Renders text whose `data-` blocks are tagged with a nonce from
 * {@link SecureRandom}. `write` says how many times its text names the nonce
 * itself. The nonce is drawn again if it occurs anywhere else in the text,
 * look-alikes included, so no content can quote it. A source that keeps
 * repeating such nonces is broken, and the effect dies rather than render.
 */
export const withFreshNonce = (
  write: (nonce: string) => { readonly text: string; readonly nonceUses: number },
): Effect.Effect<string, never, SecureRandom.SecureRandom> =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    for (let attempt = 0; attempt < NONCE_ATTEMPTS; attempt++) {
      const nonce = hex(yield* random.randomBytes(NONCE_BYTES));
      const rendered = write(nonce);
      const uses = foldForMatching(rendered.text).split(nonce).length - 1;
      if (uses === rendered.nonceUses) return rendered.text;
    }
    return yield* Effect.die(new NonceUnavailable());
  });
