// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { BRIDGE_KEY_VARIABLE, type BridgeSigner, bridgeSigner } from "./protocol.ts";

/**
 * The key the `j3` bridges and the tool endpoint sign what they send each
 * other with (`docs/architecture/server.md`, Bot tools). A new one each time
 * the server starts, held in its memory only: the engine starts every bridge
 * with it, in the bridge's entry of each harness's configuration, and a
 * harness of an earlier start, still running, holds a key no server has.
 * It is never logged, shown to a client or put in a bot's context.
 */
export class BridgeKey extends Context.Service<
  BridgeKey,
  {
    readonly signer: BridgeSigner;
    /** The variable the bridge reads the key from, for `ToolBridge.environment`. */
    readonly variable: { readonly name: string; readonly value: Redacted.Redacted<string> };
  }
>()("@j3-bots/server/tools/BridgeKey") {}

export const layer = Layer.effect(
  BridgeKey,
  Effect.gen(function* () {
    const key = yield* (yield* Mac.Mac).generateKey(Mac.hmacSha256).pipe(Effect.orDie);
    const bytes = yield* Mac.toBytes(key).pipe(Effect.orDie);
    return BridgeKey.of({
      signer: yield* bridgeSigner(key),
      variable: { name: BRIDGE_KEY_VARIABLE, value: Redacted.make(Base64Url.encode(bytes)) },
    });
  }),
).pipe(Layer.provide(Mac.layerWebCrypto), Layer.provide(SecureRandom.layerWebCrypto));
