// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Socket from "effect/socket/Socket";
import { ReconnectPolicy } from "../src/connection/Connection.ts";
import { OutboxSweep } from "../src/stores/Conversations.ts";
import {
  ClientStorage,
  CredentialStore,
  type DeviceCredential,
  FileTransfer,
  LocalStorageError,
  type LocalTable,
  makeInProcessLocks,
  Network,
  type NetworkStatus,
  ServerAddress,
  TransferFailed,
  WindowLocks,
} from "../src/ports.ts";

/** Test controls over the device's network: its status, and the sockets open on it. */
export class TestNetwork extends Context.Service<
  TestNetwork,
  {
    readonly set: (status: NetworkStatus) => Effect.Effect<void>;
    /** Closes every socket the client opened, as a network failure would. */
    readonly dropSockets: Effect.Effect<void>;
    /**
     * While `true`, what the server sends on the open sockets never reaches
     * the client, as on a link that fails one way: requests still arrive.
     */
    readonly loseReplies: (lose: boolean) => Effect.Effect<void>;
  }
>()("@j3-bots/client-runtime/test/platform/TestNetwork") {}

const network = Layer.effectContext(
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make<NetworkStatus>("online");
    const sockets = new Set<Socket.WebSocketLike>();
    const global = yield* Socket.WebSocketConstructor;
    let losing = false;
    /** `socket`, whose messages reach the client unless replies are lost. */
    const lossy = (socket: Socket.WebSocketLike): Socket.WebSocketLike => {
      const wrapped = new Map<
        (event: Socket.WebSocketEvent) => void,
        (event: Socket.WebSocketEvent) => void
      >();
      return {
        get readyState() {
          return socket.readyState;
        },
        addEventListener: (type, listener, options) => {
          if (type !== "message") return socket.addEventListener(type, listener, options);
          const filtered = (event: Socket.WebSocketEvent) => {
            if (!losing) listener(event);
          };
          wrapped.set(listener, filtered);
          socket.addEventListener(type, filtered, options);
        },
        removeEventListener: (type, listener) =>
          socket.removeEventListener(type, wrapped.get(listener) ?? listener),
        close: (code, reason) => socket.close(code, reason),
        send: (data) => socket.send(data),
      };
    };
    return Context.make(
      Network,
      Network.of({ status: SubscriptionRef.get(status), changes: SubscriptionRef.changes(status) }),
    ).pipe(
      Context.add(
        Socket.WebSocketConstructor,
        Socket.WebSocketConstructor.of((url, options) => {
          const socket = global(url, options);
          sockets.add(socket);
          return lossy(socket);
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
          loseReplies: (lose) =>
            Effect.sync(() => {
              losing = lose;
            }),
        }),
      ),
    );
  }),
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));

/** One window's watch on the device's credential: what it is told when another window changes it. */
interface CredentialWatcher {
  readonly window: object;
  readonly tell: () => void;
}

/**
 * The device's credential storage, in memory, as each window sees it:
 * `view(window)` tells every other window's watchers when it saves or clears
 * the credential. A window given `heard` hears of each change only once that
 * latch is open, as a tab that has not yet run the message a broadcast left it.
 */
const makeCredentials = () => {
  let stored = Option.none<DeviceCredential>();
  const watchers = new Set<CredentialWatcher>();
  const changed = (window: object) =>
    Effect.sync(() => {
      for (const watcher of watchers) if (watcher.window !== window) watcher.tell();
    });
  return {
    seed: (credential: DeviceCredential) => {
      stored = Option.some(credential);
    },
    view: (window: object, heard?: Latch.Latch) =>
      CredentialStore.of({
        load: Effect.sync(() => stored),
        save: (credential) =>
          Effect.sync(() => {
            stored = Option.some(credential);
          }).pipe(Effect.andThen(changed(window))),
        clear: (credential) =>
          Effect.suspend(() => {
            const held = Option.exists(
              stored,
              (current) =>
                current.deviceId === credential.deviceId &&
                Redacted.value(current.token) === Redacted.value(credential.token),
            );
            if (!held) return Effect.succeed(stored);
            stored = Option.none();
            return changed(window).pipe(Effect.as(stored));
          }),
        changes: Stream.callback<void>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const watcher: CredentialWatcher = {
                window,
                tell: () => void Queue.offerUnsafe(queue, undefined),
              };
              watchers.add(watcher);
              return watcher;
            }),
            (watcher) => Effect.sync(() => watchers.delete(watcher)),
          ),
        ).pipe(Stream.mapEffect(() => heard?.await ?? Effect.void)),
      }),
  };
};

interface StorageOptions {
  /** Fails every transaction while it says so, as a full disk would. */
  readonly refuseCommits?: () => boolean;
  /** Fails every attempt to empty a table. */
  readonly refuseClears?: boolean;
  /** Holds every transaction until the latch opens, before it can fail. */
  readonly commitGate?: Latch.Latch;
  /** Receives one item as each transaction starts, before the gate. */
  readonly committing?: Queue.Queue<void>;
  /** Holds every read, once it has read, until the latch opens. */
  readonly readGate?: Latch.Latch;
  /** Receives one item as each read the gate holds has read. */
  readonly reading?: Queue.Queue<void>;
}

/** One window's watch on the device's storage: what it is told when another window changes it. */
interface Watcher {
  readonly window: object;
  readonly tell: (table: LocalTable) => void;
}

/**
 * The device's storage for drafts and unsent messages, in memory, as each
 * window sees it: `view(window)` tells every other window's watchers of the
 * tables it changes, unless `announce` is false. Like IndexedDB, it reads a
 * table in the order of its keys.
 */
const makeStorage = (options: StorageOptions) => {
  const tables = new Map<LocalTable, Map<string, string>>([
    ["drafts", new Map()],
    ["outbox", new Map()],
  ]);
  const table = (name: LocalTable) => tables.get(name) ?? new Map<string, string>();
  const watchers = new Set<Watcher>();
  return (window: object, announce = true) => {
    const changed = (names: Iterable<LocalTable>) =>
      Effect.sync(() => {
        if (!announce) return;
        for (const name of new Set(names)) {
          for (const watcher of watchers) if (watcher.window !== window) watcher.tell(name);
        }
      });
    return ClientStorage.of({
      readAll: (name) =>
        Effect.sync(
          () => new Map([...table(name)].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        ).pipe(
          Effect.tap(() => {
            const gate = options.readGate;
            if (gate === undefined || gate.isOpen()) return Effect.void;
            return (
              options.reading === undefined ? Effect.void : Queue.offer(options.reading, undefined)
            ).pipe(Effect.andThen(gate.await));
          }),
        ),
      write: (name, key, value) =>
        Effect.sync(() => void table(name).set(key, value)).pipe(Effect.andThen(changed([name]))),
      remove: (name, key) =>
        Effect.sync(() => void table(name).delete(key)).pipe(Effect.andThen(changed([name]))),
      clear: (name) =>
        options.refuseClears === true
          ? Effect.fail(new LocalStorageError({ operation: "remove" }))
          : Effect.sync(() => table(name).clear()).pipe(Effect.andThen(changed([name]))),
      commit: (changes, expected = []) =>
        (options.committing === undefined
          ? Effect.void
          : Queue.offer(options.committing, undefined)
        ).pipe(
          Effect.andThen(options.commitGate?.await ?? Effect.void),
          Effect.andThen(
            Effect.suspend(() =>
              options.refuseCommits?.() === true
                ? Effect.fail(new LocalStorageError({ operation: "write" }))
                : Effect.sync(() => {
                    const holds = expected.every(
                      ({ table: name, key, value }) => (table(name).get(key) ?? null) === value,
                    );
                    if (!holds) return false;
                    for (const { table: name, key, value } of changes) {
                      if (value === null) table(name).delete(key);
                      else table(name).set(key, value);
                    }
                    return true;
                  }).pipe(
                    Effect.tap((applied) =>
                      applied ? changed(changes.map((change) => change.table)) : Effect.void,
                    ),
                  ),
            ),
          ),
        ),
      changes: Stream.callback<LocalTable>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const watcher: Watcher = {
              window,
              tell: (name) => void Queue.offerUnsafe(queue, name),
            };
            watchers.add(watcher);
            return watcher;
          }),
          (watcher) => Effect.sync(() => watchers.delete(watcher)),
        ),
      ),
    });
  };
};

/**
 * Uploads over the platform's `HttpClient`, the same one every other request
 * takes, which reports no progress until the end. A failure on the way fails
 * the transfer.
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
          return { url: response.url, status: response.status, body };
        }).pipe(Effect.mapError(() => new TransferFailed())),
    });
  }),
);

/**
 * What clients of one device share: a second client on it is the same device
 * after a reload, or another tab of the same browser.
 */
export interface TestDevice {
  /** The device's storage, as the test reads it. */
  readonly storage: ClientStorage["Service"];
  /** The device's storage as one more window of the client sees it. */
  readonly window: () => ClientStorage["Service"];
  /**
   * As `window`, for a window that never tells the others what it changed,
   * as a tab that closes between a transaction and its announcement.
   */
  readonly unannounced: () => ClientStorage["Service"];
  readonly locks: WindowLocks["Service"];
  /** Saves `credential` as the device's, as an earlier launch left it. */
  readonly seed: (credential: DeviceCredential) => void;
  /**
   * The device's credential as one more window sees it. Given `heard`, the
   * window hears of another window's change only once the latch is open.
   */
  readonly credentials: (heard?: Latch.Latch) => CredentialStore["Service"];
}

export const makeDevice = (options: StorageOptions = {}): TestDevice => {
  const view = makeStorage(options);
  const credentials = makeCredentials();
  return {
    storage: view({}),
    window: () => view({}),
    unannounced: () => view({}, false),
    locks: makeInProcessLocks(),
    seed: credentials.seed,
    credentials: (heard) => credentials.view({}, heard),
  };
};

/**
 * A platform for tests: the device's credential in memory, `stored` when given, a network the test turns
 * off and on, Node's own `fetch` and `WebSocket`, and retries in milliseconds.
 * `http` stands between the client and the server, as a reverse proxy would,
 * for every HTTP request and upload.
 */
export const layer = (
  origin: URL,
  stored: Option.Option<DeviceCredential> = Option.none(),
  device: TestDevice = makeDevice(),
  http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
) =>
  Layer.mergeAll(
    Layer.succeed(ServerAddress, { origin }),
    Layer.sync(CredentialStore, () => {
      if (Option.isSome(stored)) device.seed(stored.value);
      return device.credentials();
    }),
    Layer.sync(ClientStorage, device.window),
    Layer.succeed(WindowLocks, device.locks),
    transfer.pipe(Layer.provide(http)),
    network,
    http,
    SecureRandom.layerWebCrypto,
    // Short enough that a test sees a sweep, long enough that most deliveries are told.
    Layer.succeed(OutboxSweep, Duration.millis(100)),
    Layer.succeed(ReconnectPolicy, {
      initialDelay: Duration.millis(5),
      maxDelay: Duration.millis(20),
      openTimeout: Duration.seconds(5),
      requestTimeout: Duration.seconds(1),
      pingTimeout: Duration.seconds(15),
    }),
  );
