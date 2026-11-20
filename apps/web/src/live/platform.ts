// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ClientStorage,
  CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
  FileTransfer,
  type LocalRecord,
  LocalStorageError,
  type LocalTable,
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
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";
import * as Idb from "./idb";

/**
 * The device credential, as IndexedDB keeps it. A non-extractable WebCrypto
 * key would not help: the server is also served over plain HTTP on a local
 * network, where WebCrypto's subtle API does not exist, and a script running
 * on this origin could use such a key as freely as read the token.
 */
const StoredCredential = Schema.fromJsonString(
  Schema.Struct({ deviceId: DeviceId, token: DeviceToken }),
);
const decodeCredential = Schema.decodeUnknownOption(StoredCredential);
const encodeCredential = Schema.encodeSync(StoredCredential);
const CREDENTIAL_KEY = "device";

/**
 * Tells this origin's other tabs that the stored credential changed, so a
 * pairing or a sign-out in one takes effect in all of them.
 */
const CREDENTIAL_CHANNEL = "j3-bots-credential";

const credentials = Layer.effect(
  CredentialStore,
  Effect.gen(function* () {
    const channel = yield* Effect.acquireRelease(
      Effect.sync(() => new BroadcastChannel(CREDENTIAL_CHANNEL)),
      (opened) => Effect.sync(() => opened.close()),
    );
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel stays within its origin and takes no target
    const announce = Effect.sync(() => channel.postMessage(null));
    return CredentialStore.of({
      load: Effect.tryPromise({
        try: () => Idb.get("credentials", CREDENTIAL_KEY),
        catch: () => new CredentialStorageError({ operation: "load" }),
      }).pipe(
        Effect.map((stored) =>
          stored === undefined
            ? Option.none()
            : decodeCredential(stored).pipe(
                Option.map(({ deviceId, token }) => ({ deviceId, token: Redacted.make(token) })),
              ),
        ),
      ),
      save: Effect.fn("CredentialStore.save")((credential: DeviceCredential) =>
        Effect.tryPromise({
          try: () =>
            Idb.put(
              "credentials",
              CREDENTIAL_KEY,
              encodeCredential({
                deviceId: credential.deviceId,
                token: Redacted.value(credential.token),
              }),
            ),
          catch: () => new CredentialStorageError({ operation: "save" }),
        }).pipe(Effect.andThen(announce)),
      ),
      clear: Effect.tryPromise({
        try: () => Idb.remove("credentials", CREDENTIAL_KEY),
        catch: () => new CredentialStorageError({ operation: "clear" }),
      }).pipe(Effect.andThen(announce)),
      changes: Stream.fromEventListener(channel, "message").pipe(Stream.as(undefined)),
    });
  }),
);

const idbRecord = ({ table, key, value }: LocalRecord) => ({ store: table, key, value });

const storage = Layer.succeed(
  ClientStorage,
  ClientStorage.of({
    readAll: Effect.fn("ClientStorage.readAll")((table: LocalTable) =>
      Effect.tryPromise({
        try: () => Idb.getAll(table),
        catch: () => new LocalStorageError({ operation: "read" }),
      }).pipe(
        Effect.map((records) => {
          const text = new Map<string, string>();
          for (const [key, value] of records) if (typeof value === "string") text.set(key, value);
          return text;
        }),
      ),
    ),
    write: Effect.fn("ClientStorage.write")((table: LocalTable, key: string, value: string) =>
      Effect.tryPromise({
        try: () => Idb.put(table, key, value),
        catch: () => new LocalStorageError({ operation: "write" }),
      }),
    ),
    remove: Effect.fn("ClientStorage.remove")((table: LocalTable, key: string) =>
      Effect.tryPromise({
        try: () => Idb.remove(table, key),
        catch: () => new LocalStorageError({ operation: "remove" }),
      }),
    ),
    clear: Effect.fn("ClientStorage.clear")((table: LocalTable) =>
      Effect.tryPromise({
        try: () => Idb.clear(table),
        catch: () => new LocalStorageError({ operation: "remove" }),
      }),
    ),
    commit: Effect.fn("ClientStorage.commit")(
      (changes: ReadonlyArray<LocalRecord>, expected: ReadonlyArray<LocalRecord> = []) =>
        Effect.tryPromise({
          try: () => Idb.commit(changes.map(idbRecord), expected.map(idbRecord)),
          catch: () => new LocalStorageError({ operation: "write" }),
        }),
    ),
  }),
);

/**
 * Asks for the lock `name` and resolves once this tab holds it. `release`
 * lets go of it, or withdraws the request if it is still waiting.
 */
const requestLock = (name: string) => {
  const withdraw = new AbortController();
  let release = () => withdraw.abort();
  const held = new Promise<void>((granted) => {
    navigator.locks
      .request(
        name,
        { signal: withdraw.signal },
        () =>
          new Promise<void>((done) => {
            release = done;
            granted();
          }),
      )
      // A withdrawn request rejects; nothing waits for it any more.
      .catch(() => undefined);
  });
  return { held, release: () => release() };
};

/**
 * The Web Locks API: one lock per name across every tab of this origin. It
 * exists only in a secure context; a page served over plain HTTP on a local
 * network locks within its own tab.
 */
const locks = Layer.sync(WindowLocks, () =>
  window.isSecureContext
    ? WindowLocks.of({
        withLock: Effect.fn("WindowLocks.withLock")(function* <A, E, R>(
          name: string,
          effect: Effect.Effect<A, E, R>,
        ) {
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => requestLock(name)),
            (request) => Effect.promise(() => request.held).pipe(Effect.andThen(effect)),
            (request) => Effect.sync(request.release),
          );
        }),
      })
    : makeInProcessLocks(),
);

/** Uploads with `XMLHttpRequest`, the one browser API that reports upload progress. */
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
        xhr.onload = () => resume(Effect.succeed({ status: xhr.status, body: xhr.responseText }));
        xhr.onerror = () => resume(Effect.fail(new TransferFailed()));
        xhr.send(request.body);
        return Effect.sync(() => xhr.abort());
      }),
    ),
  }),
);

const statusNow = (): NetworkStatus => (navigator.onLine ? "online" : "offline");

const network = Layer.succeed(
  Network,
  Network.of({
    status: Effect.sync(statusNow),
    changes: Stream.merge(
      Stream.fromEventListener(window, "online"),
      Stream.fromEventListener(window, "offline"),
    ).pipe(Stream.map(statusNow)),
  }),
);

/**
 * The browser's platform. The server is the page's own origin: the server
 * serves this app, and the browser sends nothing anywhere else.
 */
export const platform: Layer.Layer<Platform> = Layer.mergeAll(
  Layer.succeed(ServerAddress, { origin: new URL(window.location.origin) }),
  credentials,
  storage,
  locks,
  transfer,
  network,
  FetchHttpClient.layer,
  Socket.layerWebSocketConstructorGlobal,
  SecureRandom.layerWebCrypto,
);
