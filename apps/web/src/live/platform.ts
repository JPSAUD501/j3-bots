// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Cell,
  ClientStorage,
  CredentialStore,
  FileTransfer,
  type LocalRecord,
  LocalStorageError,
  LocalTable,
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
import type { DeviceId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";
import { type CredentialCell, type CredentialCodec, makeCredentialStore } from "./credentialStore";
import { type Desktop, desktop } from "./desktop";
import * as Idb from "./idb";
import { sealedCredential, storedProtection } from "./sealedCredential";
import { credentialRecord, plainCredential } from "./storedCredential";

const CREDENTIAL_KEY = "device";

/**
 * Tells this origin's other tabs that the stored credential changed, so a
 * pairing or a sign-out in one takes effect in all of them.
 */
const CREDENTIAL_CHANNEL = "j3-bots-credential";

/**
 * The credential's one record in IndexedDB, beside the drafts and the
 * outbox. `observe` is given each value read from it or stored in it.
 */
const credentialCell = (observe: (stored: unknown) => void): CredentialCell => ({
  get: () =>
    Idb.get("credentials", CREDENTIAL_KEY).then((stored) => {
      observe(stored);
      return stored;
    }),
  put: (value) => Idb.put("credentials", CREDENTIAL_KEY, value).then(() => observe(value)),
  swap: (expected, next) =>
    Idb.commit(
      [{ store: "credentials", key: CREDENTIAL_KEY, value: next }],
      [Idb.holding({ store: "credentials", key: CREDENTIAL_KEY, value: expected })],
    ).then((stored) => {
      if (stored) observe(next);
      return stored;
    }),
});

/**
 * In the desktop app, whether the credential on disk keeps its token only
 * obscured, as this page last read or stored it. Another window's change is
 * read here as the client follows it.
 */
export const signInUnencrypted = new Cell(false);

const credentials = (codec: CredentialCodec, cell: CredentialCell) =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const channel = yield* Effect.acquireRelease(
        Effect.sync(() => new BroadcastChannel(CREDENTIAL_CHANNEL)),
        (opened) => Effect.sync(() => opened.close()),
      );
      return makeCredentialStore({
        codec,
        cell,
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel stays within its origin and takes no target
        announce: Effect.sync(() => channel.postMessage(null)),
        changes: Stream.fromEventListener(channel, "message").pipe(Stream.as(undefined)),
      });
    }),
  );

const idbRecord = ({ table, key, value }: LocalRecord) => ({ store: table, key, value });

/**
 * The expectation that the device's credential, issued by the server `codec`
 * reads for, is `pairing`'s, read in the transaction it guards.
 */
const credentialOf = (codec: CredentialCodec, pairing: DeviceId): Idb.IdbExpectation => ({
  store: "credentials",
  key: CREDENTIAL_KEY,
  holds: (stored) => Option.contains(codec.pairingOf(stored), pairing),
});

/**
 * Tells this origin's other tabs which table of the client's records changed,
 * so an unsent message one tab kept is sent by another if the first closes.
 */
const STORAGE_CHANNEL = "j3-bots-storage";
const decodeTable = Schema.decodeUnknownOption(LocalTable);

const storage = (codec: CredentialCodec) =>
  Layer.effect(
    ClientStorage,
    Effect.gen(function* () {
      const channel = yield* Effect.acquireRelease(
        Effect.sync(() => new BroadcastChannel(STORAGE_CHANNEL)),
        (opened) => Effect.sync(() => opened.close()),
      );
      const announce = (tables: Iterable<LocalTable>) =>
        Effect.sync(() => {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel stays within its origin and takes no target
          for (const table of new Set(tables)) channel.postMessage(table);
        });
      return ClientStorage.of({
        readAll: Effect.fn("ClientStorage.readAll")((table: LocalTable) =>
          Effect.tryPromise({
            try: () => Idb.getAll(table),
            catch: () => new LocalStorageError({ operation: "read" }),
          }).pipe(
            Effect.map((records) => {
              const text = new Map<string, string>();
              for (const [key, value] of records)
                if (typeof value === "string") text.set(key, value);
              return text;
            }),
          ),
        ),
        write: Effect.fn("ClientStorage.write")((table: LocalTable, key: string, value: string) =>
          Effect.tryPromise({
            try: () => Idb.put(table, key, value),
            catch: () => new LocalStorageError({ operation: "write" }),
          }).pipe(Effect.andThen(announce([table]))),
        ),
        remove: Effect.fn("ClientStorage.remove")((table: LocalTable, key: string) =>
          Effect.tryPromise({
            try: () => Idb.remove(table, key),
            catch: () => new LocalStorageError({ operation: "remove" }),
          }).pipe(Effect.andThen(announce([table]))),
        ),
        clear: Effect.fn("ClientStorage.clear")((table: LocalTable) =>
          Effect.tryPromise({
            try: () => Idb.clear(table),
            catch: () => new LocalStorageError({ operation: "remove" }),
          }).pipe(Effect.andThen(announce([table]))),
        ),
        commit: Effect.fn("ClientStorage.commit")(
          (
            changes: ReadonlyArray<LocalRecord>,
            expected: ReadonlyArray<LocalRecord> = [],
            pairing?: DeviceId,
          ) =>
            Effect.tryPromise({
              try: () =>
                Idb.commit(changes.map(idbRecord), [
                  ...expected.map((entry) => Idb.holding(idbRecord(entry))),
                  ...(pairing === undefined ? [] : [credentialOf(codec, pairing)]),
                ]),
              catch: () => new LocalStorageError({ operation: "write" }),
            }).pipe(
              Effect.tap((applied) =>
                applied ? announce(changes.map((change) => change.table)) : Effect.void,
              ),
            ),
        ),
        changes: Stream.callback<LocalTable>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const listener = (event: MessageEvent) => {
                const table = decodeTable(event.data);
                if (Option.isSome(table)) Queue.offerUnsafe(queue, table.value);
              };
              channel.addEventListener("message", listener);
              return listener;
            }),
            (listener) => Effect.sync(() => channel.removeEventListener("message", listener)),
          ),
        ),
      });
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
const browserTransfer = FileTransfer.of({
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
});

const statusNow = (): NetworkStatus => (navigator.onLine ? "online" : "offline");

/** The page's own `online` and `offline` events. */
const connectivityEvents = Stream.merge(
  Stream.fromEventListener(window, "online"),
  Stream.fromEventListener(window, "offline"),
);

const browserNetwork = Network.of({
  status: Effect.sync(statusNow),
  changes: connectivityEvents.pipe(Stream.map(statusNow)),
});

const statusOf = (online: boolean | null): NetworkStatus =>
  online === null ? "unknown" : online ? "online" : "offline";

/**
 * The desktop app's network status, from the main process (`net.isOnline`),
 * asked again on each of the page's connectivity events and told as the
 * system wakes from sleep, when the client should try the server at once.
 */
const desktopNetwork = (app: Desktop) => {
  const status = Effect.promise(() => app.online()).pipe(Effect.map(statusOf));
  return Network.of({
    status,
    changes: Stream.merge(
      connectivityEvents.pipe(Stream.mapEffect(() => status)),
      Stream.callback<NetworkStatus>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => app.onResumed((online) => Queue.offerUnsafe(queue, statusOf(online)))),
          (stop) => Effect.sync(stop),
        ),
      ),
    ),
  });
};

/**
 * The browser's platform, for the server at `server`. In a browser that is the
 * page's own origin: the server serves this app, and the browser sends nothing
 * anywhere else. In the desktop app it is the server the operator named, which
 * answers CORS for the app's pages (decision 0012); the page is a secure
 * context there, so everything below works as on an HTTPS origin. The
 * credential is kept with the server that issued it, and is absent for any
 * other: clearing the page's storage on a change of server cannot be relied on
 * alone to keep a token from reaching a server that did not issue it. In the
 * desktop app the token is kept only as the app sealed it with the system's
 * key, and the network status comes from the app; the credential stays in
 * the same database as the drafts and the outbox, so a write's pairing check
 * is still one transaction. Files go up with `XMLHttpRequest` there too.
 */
export const makePlatform = (server: URL): Layer.Layer<Platform> => {
  const codec =
    desktop === null
      ? plainCredential(credentialRecord(server, window.location.origin))
      : sealedCredential(server, desktop);
  const cell = credentialCell((stored) =>
    signInUnencrypted.set(
      desktop !== null && Option.contains(storedProtection(server, stored), "unencrypted"),
    ),
  );
  return Layer.mergeAll(
    Layer.succeed(ServerAddress, { origin: server }),
    credentials(codec, cell),
    storage(codec),
    locks,
    Layer.succeed(FileTransfer, browserTransfer),
    Layer.succeed(Network, desktop === null ? browserNetwork : desktopNetwork(desktop)),
    FetchHttpClient.layer,
    Socket.layerWebSocketConstructorGlobal,
    SecureRandom.layerWebCrypto,
  );
};
