// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// What the desktop app's preload script and main process exchange with the web
// client they host. This is not wire between the server and its clients, so it
// lives apart from `@j3-bots/contracts`. Every value that crosses the bridge is
// decoded on the side that receives it: the main process decodes what a page
// asks, and the page decodes what the main process answers.

export {
  BRIDGE_KEY,
  type DesktopBridge,
  IPC_CHANNELS,
  UPLOAD_TAGS,
  type UploadHandle,
} from "./channels.ts";

/** An `http:` or `https:` origin: scheme, host and port, nothing more. */
export const ServerOrigin = Schema.String.check(
  Schema.makeFilter((text: string) => {
    const url = URL.parse(text);
    return (
      (url !== null &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === text) ||
      "an http: or https: origin"
    );
  }),
).pipe(Schema.brand("ServerOrigin"));
export type ServerOrigin = typeof ServerOrigin.Type;

/**
 * How the device token is kept on disk: `encrypted` with a key the system
 * keeps (the macOS Keychain, Windows DPAPI, a Linux secret service), or
 * `unencrypted`, where Linux has no secret service the app can use: then it
 * is only obscured, and anyone who can read the profile can recover it.
 */
export const TokenProtection = Schema.Literals(["encrypted", "unencrypted"]);
export type TokenProtection = typeof TokenProtection.Type;

/** What the desktop app holds that the page needs before it starts. */
export const DesktopState = Schema.Struct({
  /** The server the operator named, or `null` until they have. */
  server: Schema.NullOr(ServerOrigin),
  /** How a token sealed now is kept. */
  tokenProtection: TokenProtection,
});
export type DesktopState = typeof DesktopState.Type;

/** The address the operator typed on the server address screen, as typed. */
export const ConnectRequest = Schema.Struct({
  address: Schema.String.check(Schema.isMaxLength(2048)),
});
export type ConnectRequest = typeof ConnectRequest.Type;

/**
 * Why an address was not kept: it is not an address (`invalid`), it asks for
 * plain HTTP to a host that is not loopback or a private IP address
 * (`needs-https`), nothing answered there (`unreachable`), what answered is
 * not a J3 Bots server (`not-j3-bots`), the app already keeps a server, which
 * must be forgotten first (`server-kept`), or the app could not save it
 * (`not-saved`).
 */
export const ConnectRefusal = Schema.Literals([
  "invalid",
  "needs-https",
  "unreachable",
  "not-j3-bots",
  "server-kept",
  "not-saved",
]);
export type ConnectRefusal = typeof ConnectRefusal.Type;

export const ConnectResult = Schema.Union([
  /** The server answered and is kept; the page loads again to connect to it. */
  Schema.TaggedStruct("connected", { server: ServerOrigin }),
  Schema.TaggedStruct("refused", { reason: ConnectRefusal }),
]);
export type ConnectResult = typeof ConnectResult.Type;

/**
 * How forgetting the server ended: `forgotten`, and the page loads again on
 * the server address screen, or `failed`, and the server is still kept.
 */
export const ForgetResult = Schema.Literals(["forgotten", "failed"]);
export type ForgetResult = typeof ForgetResult.Type;

/** A device token as the page asks the app to seal it, or the app answers it opened. */
const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));

/** A sealed token: base64, as the page stores it. */
const Sealed = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
);

export const SealRequest = Schema.Struct({ token: Token });
export type SealRequest = typeof SealRequest.Type;

export const SealResult = Schema.Union([
  /** The token, encrypted for this profile, and how. */
  Schema.TaggedStruct("sealed", { sealed: Sealed, protection: TokenProtection }),
  Schema.TaggedStruct("failed", {}),
]);
export type SealResult = typeof SealResult.Type;

export const OpenRequest = Schema.Struct({ sealed: Sealed });
export type OpenRequest = typeof OpenRequest.Type;

export const OpenResult = Schema.Union([
  Schema.TaggedStruct("opened", { token: Token }),
  /** What was stored is not a token this profile sealed, or the key that sealed it is gone. */
  Schema.TaggedStruct("failed", {}),
]);
export type OpenResult = typeof OpenResult.Type;

/** Whether the system has a network (Electron's `net.isOnline`). */
export const NetworkState = Schema.Struct({ online: Schema.Boolean });
export type NetworkState = typeof NetworkState.Type;

/** An upload as the page asks for it: where, and the headers it goes with. */
export const UploadRequest = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(4096)),
  headers: Schema.Record(Schema.String, Schema.String),
});
export type UploadRequest = typeof UploadRequest.Type;

/** A byte count. */
const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** An upload as the preload script posts it to the main process, with its body's size. */
export const UploadStart = Schema.Struct({ request: UploadRequest, size: Bytes });
export type UploadStart = typeof UploadStart.Type;

/** What the preload script sends of the body, when the main process pulls it. */
export const UploadBody = Schema.Union([
  Schema.TaggedStruct("chunk", { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct("end", {}),
]);
export type UploadBody = typeof UploadBody.Type;

/** How many of the body's bytes have gone, as the page is told. */
export const UploadProgress = Bytes;

/** How an upload ended: the server's answer, before the page reads it, or `failed`. */
export const UploadOutcome = Schema.Union([
  Schema.TaggedStruct("answered", {
    /** Where the answer came from: the request's address, or where a redirect, not followed, points. */
    url: Schema.String,
    status: Schema.Int,
    body: Schema.String,
  }),
  Schema.TaggedStruct("failed", {}),
]);
export type UploadOutcome = typeof UploadOutcome.Type;

/** A function, called only to have its answer decoded. */
const Callable = Schema.declare(
  (input: unknown): input is (...args: ReadonlyArray<unknown>) => unknown =>
    Predicate.isFunction(input),
);

/** A promise, awaited only to have its value decoded. */
const Awaitable = Schema.declare(
  (input: unknown): input is Promise<unknown> => input instanceof Promise,
);

/** What `upload` answers, as the page decodes it. */
export const HostedUpload = Schema.Struct({ done: Awaitable, abort: Callable });

/**
 * `window[BRIDGE_KEY]` as the page decodes it: a page in a browser finds
 * nothing there, and the desktop app's page finds its state and its calls.
 */
export const HostedBridge = Schema.Struct({
  state: DesktopState,
  connect: Callable,
  forgetServer: Callable,
  sealToken: Callable,
  openToken: Callable,
  networkStatus: Callable,
  onResumed: Callable,
  upload: Callable,
});
export type HostedBridge = typeof HostedBridge.Type;
