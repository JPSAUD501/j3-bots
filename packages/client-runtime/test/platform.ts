// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Socket from "effect/socket/Socket";
import { ReconnectPolicy } from "../src/connection/Connection.ts";
import {
  ClientStorage,
  CredentialStore,
  type DeviceCredential,
  FileTransfer,
  LocalStorageError,
  type LocalTable,
  Network,
  type NetworkStatus,
  ServerAddress,
  TransferFailed,
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
        changes: Stream.never,
      });
    }),
  );

/**
 * The device's storage for drafts and unsent messages, in memory. Made apart
 * from a client, so a second client on it is the same device after a reload.
 * `refuseCommits` fails every transaction, as a full disk would.
 */
export const makeStorage = (options: { readonly refuseCommits?: boolean } = {}) => {
  const tables = new Map<LocalTable, Map<string, string>>([
    ["drafts", new Map()],
    ["outbox", new Map()],
  ]);
  const table = (name: LocalTable) => tables.get(name) ?? new Map<string, string>();
  return ClientStorage.of({
    readAll: (name) => Effect.sync(() => new Map(table(name))),
    write: (name, key, value) => Effect.sync(() => void table(name).set(key, value)),
    remove: (name, key) => Effect.sync(() => void table(name).delete(key)),
    clear: (name) => Effect.sync(() => table(name).clear()),
    commit: (changes) =>
      options.refuseCommits === true
        ? Effect.fail(new LocalStorageError({ operation: "write" }))
        : Effect.sync(() => {
            for (const { table: name, key, value } of changes) {
              if (value === null) table(name).delete(key);
              else table(name).set(key, value);
            }
          }),
  });
};

/**
 * Uploads over the platform's `HttpClient`, which reports no progress until
 * the end. A failure on the way fails the transfer.
 */
const transfer = Layer.effect(
  FileTransfer,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return FileTransfer.of({
      upload: (request) =>
        Effect.gen(function* () {
          const bytes = yield* Effect.promise(() => request.body.arrayBuffer());
          const response = yield* http.execute(
            HttpClientRequest.post(request.url).pipe(
              HttpClientRequest.setHeaders(request.headers),
              HttpClientRequest.bodyUint8Array(
                new Uint8Array(bytes),
                request.headers["content-type"],
              ),
            ),
          );
          const body = yield* response.text;
          request.onProgress(request.body.size);
          return { status: response.status, body };
        }).pipe(Effect.mapError(() => new TransferFailed())),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * A platform for tests: the credential in memory, a network the test turns
 * off and on, Node's own `fetch` and `WebSocket`, and retries in milliseconds.
 */
export const layer = (
  origin: URL,
  stored: Option.Option<DeviceCredential> = Option.none(),
  storage: ClientStorage["Service"] = makeStorage(),
) =>
  Layer.mergeAll(
    Layer.succeed(ServerAddress, { origin }),
    credentials(stored),
    Layer.succeed(ClientStorage, storage),
    transfer,
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
