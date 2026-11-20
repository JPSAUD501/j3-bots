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
 * keystore on mobile, the OS credential vault on desktop, and on the web
 * IndexedDB, which only pages of the server's own origin can read. The
 * runtime keeps no other copy on disk.
 */
export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly load: Effect.Effect<Option.Option<DeviceCredential>, CredentialStorageError>;
    readonly save: (credential: DeviceCredential) => Effect.Effect<void, CredentialStorageError>;
    readonly clear: Effect.Effect<void, CredentialStorageError>;
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
 * What the client keeps on the device besides the credential. Neither holds a
 * secret, but both hold conversation text, so signing out clears them.
 */
export type LocalTable =
  /** Each conversation's unsent text and the files already uploaded for it. */
  | "drafts"
  /** Messages the operator sent that the server has not accepted yet. */
  | "outbox";

/** One change to the client's records: the record's new value, or `null` to remove it. */
export interface LocalChange {
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
     * one table to another is never in both and never in neither.
     */
    readonly commit: (
      changes: ReadonlyArray<LocalChange>,
    ) => Effect.Effect<void, LocalStorageError>;
  }
>()("@j3-bots/client-runtime/ports/ClientStorage") {}

/** One upload, as the runtime asks the platform to send it. */
export interface UploadRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob;
  /** Called as the body's bytes leave the device, with how many have so far. */
  readonly onProgress: (sent: number) => void;
}

/** The server's answer to an upload, before the runtime reads it. */
export interface UploadResponse {
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
 * Sends a file's bytes to the server and reports progress as they go, which
 * `fetch` cannot do: `XMLHttpRequest` in a browser, the platform's upload task
 * elsewhere. Interrupting the effect aborts the transfer.
 */
export class FileTransfer extends Context.Service<
  FileTransfer,
  {
    readonly upload: (request: UploadRequest) => Effect.Effect<UploadResponse, TransferFailed>;
  }
>()("@j3-bots/client-runtime/ports/FileTransfer") {}
