// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ClientStorage,
  CredentialStore,
  FileTransfer,
  makeInProcessLocks,
  Network,
  type NetworkStatus,
  type Platform,
  ServerAddress,
  TransferFailed,
  type UploadRequest,
  type UploadResponse,
  WindowLocks,
} from "@j3-bots/client-runtime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";
import * as ExpoCrypto from "expo-crypto";
import * as ExpoNetwork from "expo-network";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import {
  makeDeviceStorage,
  type SecureValue,
  type SqlDatabase,
  type SqlTransaction,
} from "./storage.ts";

const CREDENTIAL_KEY = "device-credential";

/**
 * Readable after the device is first unlocked, so a notification can be
 * handled in the background, and never restored to another device from a
 * backup: a device token is this device's alone.
 */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** The device credential in the keychain (iOS) or the keystore (Android). */
export const secureCredential: SecureValue = {
  get: () => SecureStore.getItemAsync(CREDENTIAL_KEY, SECURE_OPTIONS),
  set: (value) => SecureStore.setItemAsync(CREDENTIAL_KEY, value, SECURE_OPTIONS),
  remove: () => SecureStore.deleteItemAsync(CREDENTIAL_KEY, SECURE_OPTIONS),
};

let opened: Promise<SQLite.SQLiteDatabase> | null = null;
/** The app's database, opened on first use, and again after a failed open. */
const database = (): Promise<SQLite.SQLiteDatabase> => {
  opened ??= SQLite.openDatabaseAsync("j3-bots.db").catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
};

/**
 * Transactions on the app's database. `withTransactionAsync` lets any query
 * the app runs meanwhile into the transaction; the storage runs one operation
 * at a time, so only the transaction's own statements run in it.
 */
const sqlite: SqlDatabase = {
  transaction: async <A>(work: (sql: SqlTransaction) => Promise<A>): Promise<A> => {
    const db = await database();
    const sql: SqlTransaction = {
      all: (text, params = []) => db.getAllAsync<unknown>(text, [...params]),
      run: async (text, params = []) => {
        await db.runAsync(text, [...params]);
      },
    };
    // `withTransactionAsync` resolves with nothing: the result comes out through `box`.
    const box: { done: { readonly value: A } | null } = { done: null };
    await db.withTransactionAsync(async () => {
      box.done = { value: await work(sql) };
    });
    if (box.done === null) throw new Error("The transaction ended without running.");
    return box.done.value;
  },
};

const statusOf = (state: ExpoNetwork.NetworkState): NetworkStatus =>
  state.isConnected === true ? "online" : state.isConnected === false ? "offline" : "unknown";

/**
 * Whether the device has a network at all. Whether the internet is reachable
 * says nothing about the server, which is often on the same local network.
 */
const network = Layer.succeed(
  Network,
  Network.of({
    // A failed read says nothing either way.
    status: Effect.promise(() =>
      ExpoNetwork.getNetworkStateAsync().then(statusOf, (): NetworkStatus => "unknown"),
    ),
    changes: Stream.callback<NetworkStatus>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          ExpoNetwork.addNetworkStateListener((state) => Queue.offerUnsafe(queue, statusOf(state))),
        ),
        (subscription) => Effect.sync(() => subscription.remove()),
      ),
    ),
  }),
);

/** Uploads with React Native's `XMLHttpRequest`, which reports upload progress as `fetch` does not. */
const transfer = Layer.succeed(
  FileTransfer,
  FileTransfer.of({
    upload: Effect.fn("FileTransfer.upload")((request: UploadRequest) =>
      Effect.callback<UploadResponse, TransferFailed>((resume) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", request.url);
        for (const [name, value] of Object.entries(request.headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.upload.onprogress = (event) => request.onProgress(event.loaded);
        xhr.onload = () =>
          resume(
            Effect.succeed({ url: xhr.responseURL, status: xhr.status, body: xhr.responseText }),
          );
        xhr.onerror = () => resume(Effect.fail(new TransferFailed()));
        xhr.send(request.body);
        return Effect.sync(() => xhr.abort());
      }),
    ),
  }),
);

/** Random bytes from the platform's secure generator: Hermes has no `crypto.getRandomValues`. */
const secureRandom = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => ExpoCrypto.getRandomBytes(size)),
);

/**
 * The phone's platform for the server at `origin`. The credential is kept
 * with the origin of the server that issued it, and is absent for any other.
 */
export const makePlatform = (origin: URL): Layer.Layer<Platform> =>
  Layer.mergeAll(
    Layer.succeed(ServerAddress, { origin }),
    Layer.effectContext(
      makeDeviceStorage(sqlite, secureCredential, origin.origin).pipe(
        Effect.map(({ credentials, storage }) =>
          Context.make(CredentialStore, credentials).pipe(Context.add(ClientStorage, storage)),
        ),
      ),
    ),
    Layer.sync(WindowLocks, makeInProcessLocks),
    transfer,
    network,
    FetchHttpClient.layer,
    Socket.layerWebSocketConstructorGlobal,
    secureRandom,
  );
