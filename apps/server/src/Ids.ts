// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";

/** Lowercase Crockford base32: no `i`, `l`, `o` or `u`, so an id reads unambiguously. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 20 characters of 5 bits: 100 bits, more than enough to never collide. */
const LENGTH = 20;

/**
 * Where the server's own ids come from. A service, so a test can name what it
 * creates. Each id carries a short prefix naming its kind (`bot_…`, `entry_…`),
 * which keeps logs and the database readable; nothing parses it.
 */
export class Ids extends Context.Service<
  Ids,
  { readonly make: (prefix: string) => Effect.Effect<string> }
>()("@j3-bots/server/Ids") {}

export const layer = Layer.effect(
  Ids,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const make = Effect.fn("Ids.make")(function* (prefix: string) {
      let id = `${prefix}_`;
      for (const byte of yield* random.randomBytes(LENGTH)) id += ALPHABET[byte % ALPHABET.length];
      return id;
    });
    return Ids.of({ make });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
