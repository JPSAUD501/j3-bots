// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";
import { ReconnectPolicy } from "../src/connection/Connection.ts";
import {
  CredentialStore,
  type DeviceCredential,
  Network,
  type NetworkStatus,
  ServerAddress,
} from "../src/ports.ts";

/** Test controls over the device's network: its status, and the sockets open on it. */
export class TestNetwork extends Context.Service<
  TestNetwork,
  {
    readonly set: (status: NetworkStatus) => Effect.Effect<void>;
    /** Closes every socket the client opened, as a network failure would. */
    readonly dropSockets: Effect.Effect<void>;
  }
>()("@j3-bots/client-runtime/test/platform/TestNetwork") {}

const network = Layer.effectContext(
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make<NetworkStatus>("online");
    const sockets = new Set<Socket.WebSocketLike>();
    const global = yield* Socket.WebSocketConstructor;
    return Context.make(
      Network,
      Network.of({ status: SubscriptionRef.get(status), changes: SubscriptionRef.changes(status) }),
    ).pipe(
      Context.add(
        Socket.WebSocketConstructor,
        Socket.WebSocketConstructor.of((url, options) => {
          const socket = global(url, options);
          sockets.add(socket);
          return socket;
        }),
      ),
      Context.add(
        TestNetwork,
        TestNetwork.of({
          set: (next) => SubscriptionRef.set(status, next),
          dropSockets: Effect.sync(() => {
            for (const socket of sockets) socket.close(4000, "dropped by the test");
            sockets.clear();
          }),
        }),
      ),
    );
  }),
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));

const credentials = (stored: Option.Option<DeviceCredential>) =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make(stored);
      return CredentialStore.of({
        load: Ref.get(ref),
        save: (credential) => Ref.set(ref, Option.some(credential)),
        clear: Ref.set(ref, Option.none()),
      });
    }),
  );

/**
 * A platform for tests: the credential in memory, a network the test turns
 * off and on, Node's own `fetch` and `WebSocket`, and retries in milliseconds.
 */
export const layer = (origin: URL, stored: Option.Option<DeviceCredential> = Option.none()) =>
  Layer.mergeAll(
    Layer.succeed(ServerAddress, { origin }),
    credentials(stored),
    network,
    FetchHttpClient.layer,
    SecureRandom.layerWebCrypto,
    Layer.succeed(ReconnectPolicy, {
      initialDelay: Duration.millis(5),
      maxDelay: Duration.millis(20),
      openTimeout: Duration.seconds(5),
      pingTimeout: Duration.seconds(15),
    }),
  );
