// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceId, DeviceToken } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

// What each platform gives the runtime. The runtime imports nothing from a
// browser, Electron or React Native: every capability below is a service the
// application provides when it builds the client. Besides these, the runtime
// needs four services Effect already defines:
//
// - `HttpClient` (effect/http): `FetchHttpClient.layer` on all three platforms;
// - `Socket.WebSocketConstructor` (effect/socket): the global `WebSocket` on all
//   three, `Socket.layerWebSocketConstructorGlobal`;
// - `SecureRandom` (effect/crypto): `SecureRandom.layerWebCrypto` where
//   `crypto.getRandomValues` exists, a native generator elsewhere;
// - the `Clock`, which Effect provides by default.

/** Where the J3 Bots server listens: its `http:` or `https:` origin. */
export class ServerAddress extends Context.Service<ServerAddress, { readonly origin: URL }>()(
  "@j3-bots/client-runtime/ports/ServerAddress",
) {}

/** What a paired client keeps between launches. The token is the operator's authority. */
export interface DeviceCredential {
  readonly deviceId: DeviceId;
  readonly token: Redacted.Redacted<DeviceToken>;
}

/** The platform's secure storage could not be read or written. */
export class CredentialStorageError extends Schema.TaggedError<CredentialStorageError>()(
  "CredentialStorageError",
  { operation: Schema.Literals(["load", "save", "clear"]) },
) {
  override get message(): string {
    return `The device credential storage failed to ${this.operation}.`;
  }
}

/**
 * The device credential in the platform's secure storage: the keychain or
 * keystore on mobile, the OS credential vault on desktop, and on the web the
 * best the browser offers (a non-extractable key wrapping the token in
 * IndexedDB, for example). The runtime keeps no other copy on disk.
 */
export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly load: Effect.Effect<Option.Option<DeviceCredential>, CredentialStorageError>;
    readonly save: (credential: DeviceCredential) => Effect.Effect<void, CredentialStorageError>;
    readonly clear: Effect.Effect<void, CredentialStorageError>;
  }
>()("@j3-bots/client-runtime/ports/CredentialStore") {}

/** `unknown` until the platform has said; treated like `online`. */
export type NetworkStatus = "online" | "offline" | "unknown";

/**
 * Whether the device has a network. The browser's `online` and `offline`
 * events, Electron's `net.isOnline`, Expo's `NetInfo`. It is a hint: being
 * online does not mean the server is reachable, so the runtime only uses it
 * to stop retrying while offline and to retry at once when the network returns.
 */
export class Network extends Context.Service<
  Network,
  {
    readonly status: Effect.Effect<NetworkStatus>;
    readonly changes: Stream.Stream<NetworkStatus>;
  }
>()("@j3-bots/client-runtime/ports/Network") {}
