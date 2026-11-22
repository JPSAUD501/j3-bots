// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ClientStorage,
  CredentialStore,
  DeviceTimeZone,
  FileTransfer,
  Lifecycle,
  type LifecycleState,
  makeInProcessLocks,
  Network,
  type NetworkStatus,
  type Platform,
  ServerAddress,
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
import { fetch as expoFetch } from "expo/fetch";
import * as ExpoCrypto from "expo-crypto";
import * as ExpoNetwork from "expo-network";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { AppState } from "react-native";
import { makeSession } from "../session.ts";
import { phoneTimeZone } from "./timeZone.ts";
import { forgetOpenedFiles } from "./openFile.ts";
import { endPush } from "./push.ts";
import { makeUploader } from "./upload.ts";
import {
  forgetPairing,
  makeDeviceStorage,
  type SecureValue,
  type SqlDatabase,
  type SqlTransaction,
  storedServer,
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
const secureCredential: SecureValue = {
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
 * Transactions on the app's one database connection. Nothing else runs on it
 * while one is open: every statement the app runs is in a transaction, and
 * the storage runs them one at a time (see `serial` in `storage.ts`), so a
 * transaction's statements are its own.
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

/**
 * Only `background` puts the app aside: iOS's `inactive`, while the
 * notification center or the app switcher covers it, keeps the socket.
 */
const lifecycleOf = (status: string | null | undefined): LifecycleState =>
  status === "background" ? "background" : "foreground";

/** Whether the app is in the foreground, from React Native's `AppState`. */
const lifecycle = Layer.succeed(
  Lifecycle,
  Lifecycle.of({
    state: Effect.sync(() => lifecycleOf(AppState.currentState)),
    changes: Stream.callback<LifecycleState>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          AppState.addEventListener("change", (status) =>
            Queue.offerUnsafe(queue, lifecycleOf(status)),
          ),
        ),
        (subscription) => Effect.sync(() => subscription.remove()),
      ),
    ),
  }),
);

/**
 * Expo's `fetch`, which honors `redirect: "error"` on Android and iOS, for
 * every request the client makes: React Native's own `fetch` ignores it and
 * follows every redirect.
 */
const nativeFetch: typeof globalThis.fetch = (input, init) => expoFetch(input, init);

/** Uploads with Expo's `fetch`, which refuses a redirect: see `makeUploader`. */
const transfer = Layer.succeed(
  FileTransfer,
  FileTransfer.of({ upload: makeUploader(nativeFetch) }),
);

/** Random bytes from the platform's secure generator: Hermes has no `crypto.getRandomValues`. */
const secureRandom = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => ExpoCrypto.getRandomBytes(size)),
);

/** The phone's time zone, which it gives the server on every socket. */
const timeZone = Layer.succeed(DeviceTimeZone, { current: Effect.sync(phoneTimeZone) });

/**
 * The phone's platform for the server at `origin`. The credential is kept
 * with the origin of the server that issued it, and is absent for any other.
 */
const makePlatform = (origin: URL): Layer.Layer<Platform> =>
  Layer.mergeAll(
    Layer.succeed(ServerAddress, { origin }),
    Layer.effectContext(
      Effect.sync(() => {
        const { credentials, storage } = makeDeviceStorage(sqlite, secureCredential, origin.origin);
        return Context.make(CredentialStore, credentials).pipe(Context.add(ClientStorage, storage));
      }),
    ),
    Layer.sync(WindowLocks, makeInProcessLocks),
    transfer,
    network,
    lifecycle,
    timeZone,
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, nativeFetch))),
    Socket.layerWebSocketConstructorGlobal,
    secureRandom,
  );

/** The app's one session, over this phone's storage. */
export const session = makeSession({
  storedServer: storedServer(secureCredential),
  forget: forgetPairing(sqlite, secureCredential),
  forgetFiles: Effect.sync(forgetOpenedFiles),
  makePlatform,
  endPush,
});
