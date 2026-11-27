// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceId, DeviceToken, TelemetryOs, TelemetrySurface } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

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

/** Where a pairing whose credential is deleted ended: refused by the server, or only on this device. */
export type CredentialEnded = "refused" | "here";

/**
 * The device credential in the platform's secure storage: the keychain or
 * keystore on mobile, IndexedDB holding the token encrypted with the
 * system's key on desktop, and on the web IndexedDB, which only pages of the
 * server's own origin can read. The runtime keeps no other copy on disk.
 */
export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly load: Effect.Effect<Option.Option<DeviceCredential>, CredentialStorageError>;
    readonly save: (credential: DeviceCredential) => Effect.Effect<void, CredentialStorageError>;
    /**
     * Deletes `credential`, unless storage holds another one: a pairing
     * another window made since. The comparison and the deletion are one
     * transaction. Succeeds with the credential storage holds afterwards.
     *
     * `ended` says where the pairing ended. `refused`: the server refused the
     * credential, and the same transaction leaves that word in its place, so
     * a window that finds the credential gone can tell that the pairing ended
     * on the server and not only here: `refusedPairing` reads it. `here`: it
     * is only signed out on this device, and nothing is left in its place.
     */
    readonly clear: (
      credential: DeviceCredential,
      ended: CredentialEnded,
    ) => Effect.Effect<Option.Option<DeviceCredential>, CredentialStorageError>;
    /**
     * The pairing whose credential was deleted because the server refused
     * it, read afresh, until a credential is saved again. A pairing the
     * server ended never returns, so what it says stays true.
     */
    readonly refusedPairing: Effect.Effect<Option.Option<DeviceId>, CredentialStorageError>;
    /**
     * Emits each time another window of this client saved or cleared the
     * credential, so this one loads it again: a browser's other tabs of the
     * same origin. A platform with one window never emits.
     */
    readonly changes: Stream.Stream<void>;
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

/**
 * The device's time zone, an IANA name such as `America/Sao_Paulo`:
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` in a browser and the
 * desktop app, the system's calendar on a phone. Null where the platform
 * cannot tell. Read each time a socket opens, so a device that travels gives
 * the zone it is in.
 */
export class DeviceTimeZone extends Context.Service<
  DeviceTimeZone,
  { readonly current: Effect.Effect<string | null> }
>()("@j3-bots/client-runtime/ports/DeviceTimeZone") {}

/**
 * What this client is, for usage data (decision 0099): where it runs, its
 * operating system's family, its own release, and a random id the platform
 * made once and keeps on the device. Only that id's hash leaves the device.
 * Never anything the device or its owner is called.
 */
export class ClientIdentity extends Context.Service<
  ClientIdentity,
  {
    readonly surface: TelemetrySurface;
    readonly os: TelemetryOs;
    /** The client's own release, the desktop app's or the phone app's; null for the web client the server serves. */
    readonly version: Effect.Effect<string | null>;
    /** Made at random the first time it is asked for, and the same afterwards on this device. */
    readonly randomId: Effect.Effect<string>;
  }
>()("@j3-bots/client-runtime/ports/ClientIdentity") {}

/** Whether the app is in the foreground, or the system has put it in the background. */
export type LifecycleState = "foreground" | "background";

/**
 * Whether the app is in the foreground: React Native's `AppState` on a phone.
 * In the background the client keeps no socket open, so the server pushes to
 * the device instead (`push.register`), and the client connects again when
 * the app returns. A browser tab and the desktop app have no push: they stay
 * in the foreground for the runtime, seen or not, and hear everything on
 * their socket (`alwaysForeground`).
 */
export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    readonly state: Effect.Effect<LifecycleState>;
    readonly changes: Stream.Stream<LifecycleState>;
  }
>()("@j3-bots/client-runtime/ports/Lifecycle") {}

/** The lifecycle of a client that keeps its socket for as long as it runs. */
export const alwaysForeground = Layer.succeed(
  Lifecycle,
  Lifecycle.of({ state: Effect.succeed("foreground"), changes: Stream.never }),
);

/**
 * What the client keeps on the device besides the credential: `drafts`, each
 * conversation's unsent text and the files already uploaded for it, and
 * `outbox`, messages the operator sent that the server has not accepted yet.
 * Neither holds a secret, but both hold conversation text. Each record belongs
 * to the pairing that wrote it: a window shows, keeps and sends only the
 * records of the pairing it follows, and those of a pairing that ended go.
 */
export const LocalTable = Schema.Literals(["drafts", "outbox"]);
export type LocalTable = typeof LocalTable.Type;

/** One of the client's records as it is or is to be: its value, or `null` for none. */
export interface LocalRecord {
  readonly table: LocalTable;
  readonly key: string;
  readonly value: string | null;
}

/** The device's storage for the client's own records could not be read or written. */
export class LocalStorageError extends Schema.TaggedError<LocalStorageError>()(
  "LocalStorageError",
  { operation: Schema.Literals(["read", "write", "remove"]) },
) {
  override get message(): string {
    return `The client's local storage failed to ${this.operation}.`;
  }
}

/**
 * Records the client keeps between launches so nothing the operator typed is
 * lost to a reload or a crash: IndexedDB on the web, the app's own storage
 * elsewhere. Values are text the runtime encodes and decodes with its own
 * schemas. Each record is written alone, so two windows of one client never
 * overwrite each other's records. When the storage fails, the client carries
 * on with what it holds in memory.
 */
export class ClientStorage extends Context.Service<
  ClientStorage,
  {
    /** Every record of `table`, by key. */
    readonly readAll: (
      table: LocalTable,
    ) => Effect.Effect<ReadonlyMap<string, string>, LocalStorageError>;
    readonly write: (
      table: LocalTable,
      key: string,
      value: string,
    ) => Effect.Effect<void, LocalStorageError>;
    readonly remove: (table: LocalTable, key: string) => Effect.Effect<void, LocalStorageError>;
    /** Removes every record of `table`. */
    readonly clear: (table: LocalTable) => Effect.Effect<void, LocalStorageError>;
    /**
     * Applies every change or none, in one transaction, so a record moved from
     * one table to another is never in both and never in neither. The same
     * transaction first reads each record of `expected`: unless every one
     * still holds the value given, it writes nothing and succeeds with `false`.
     *
     * Given `pairing`, the same transaction also reads the device's
     * credential, and writes nothing, succeeding with `false`, unless it is
     * that pairing's. A record of a pairing that has ended is then never
     * written, however late a window learns that it ended. A platform whose
     * credential storage cannot take part in the transaction must keep its own
     * copy of the paired device id, written in the same transaction as the
     * credential, where this one can read it. On the web both are in one
     * IndexedDB database.
     */
    readonly commit: (
      changes: ReadonlyArray<LocalRecord>,
      expected?: ReadonlyArray<LocalRecord>,
      pairing?: DeviceId,
    ) => Effect.Effect<boolean, LocalStorageError>;
    /**
     * Emits a table each time another window of this client changed it, so
     * this one reads it again: a browser's other tabs of the same origin. A
     * platform with one window never emits.
     */
    readonly changes: Stream.Stream<LocalTable>;
  }
>()("@j3-bots/client-runtime/ports/ClientStorage") {}

/**
 * Locks every window of this client on the device shares, so that what one
 * guards runs in one window at a time: the Web Locks API in a browser, an
 * in-process lock where the client has one window. A page served over plain
 * HTTP on a local network has no Web Locks API; each of its tabs then locks
 * for itself alone.
 */
export class WindowLocks extends Context.Service<
  WindowLocks,
  {
    /**
     * Runs `effect` once this window holds the lock `name`, and lets go of it
     * when `effect` ends. Interrupted while it waits, it gives up the request.
     */
    readonly withLock: <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("@j3-bots/client-runtime/ports/WindowLocks") {}

/** Locks held within this process only, for a platform with one window. */
export const makeInProcessLocks = (): WindowLocks["Service"] => {
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (name: string) => {
    const known = locks.get(name);
    if (known !== undefined) return known;
    const made = Semaphore.makeUnsafe(1);
    locks.set(name, made);
    return made;
  };
  return WindowLocks.of({
    withLock: Effect.fn("WindowLocks.withLock")(function* <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* lockFor(name).withPermits(1)(effect);
    }),
  });
};

/** One upload, as the runtime asks the platform to send it. */
export interface UploadRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob;
  /**
   * Called as the body's bytes leave the device, with how many have so far;
   * never, where the platform cannot tell.
   */
  readonly onProgress: (sent: number) => void;
}

/** The server's answer to an upload, before the runtime reads it. */
export interface UploadResponse {
  /** The address that answered, after any redirect (`XMLHttpRequest.responseURL`). */
  readonly url: string;
  readonly status: number;
  readonly body: string;
}

/** The upload did not reach the server, or its answer did not come back. */
export class TransferFailed extends Schema.TaggedError<TransferFailed>()("TransferFailed", {}) {
  override get message(): string {
    return "The file transfer failed.";
  }
}

/**
 * Sends a file's bytes to the server, reporting progress as they go where the
 * platform can: `XMLHttpRequest` in a browser, which `fetch` cannot match;
 * `fetch` on the phone, the one way there to refuse a redirect. Interrupting
 * the effect aborts the transfer.
 */
export class FileTransfer extends Context.Service<
  FileTransfer,
  {
    readonly upload: (request: UploadRequest) => Effect.Effect<UploadResponse, TransferFailed>;
  }
>()("@j3-bots/client-runtime/ports/FileTransfer") {}
