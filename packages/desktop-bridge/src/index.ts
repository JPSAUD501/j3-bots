// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// What the desktop app's preload script and main process exchange with the web
// client they host. This is not wire between the server and its clients, so it
// lives apart from `@j3-bots/contracts`. Every value that crosses the bridge is
// decoded on the side that receives it: the main process decodes what a page
// asks, and the page decodes what the main process answers.

export { BRIDGE_KEY, type DesktopBridge, IPC_CHANNELS } from "./channels.ts";

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

/** What the desktop app holds that the page needs before it starts. */
export const DesktopState = Schema.Struct({
  /** The server the operator named, or `null` until they have. */
  server: Schema.NullOr(ServerOrigin),
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
 * (`needs-https`), nothing answered there (`unreachable`), or what answered is
 * not a J3 Bots server (`not-j3-bots`).
 */
export const ConnectRefusal = Schema.Literals([
  "invalid",
  "needs-https",
  "unreachable",
  "not-j3-bots",
]);
export type ConnectRefusal = typeof ConnectRefusal.Type;

export const ConnectResult = Schema.Union([
  /** The server answered and is kept; the page loads again to connect to it. */
  Schema.TaggedStruct("connected", { server: ServerOrigin }),
  Schema.TaggedStruct("refused", { reason: ConnectRefusal }),
]);
export type ConnectResult = typeof ConnectResult.Type;

/** A function, called only to have its answer decoded. */
const Callable = Schema.declare(
  (input: unknown): input is (...args: ReadonlyArray<unknown>) => unknown =>
    Predicate.isFunction(input),
);

/**
 * `window[BRIDGE_KEY]` as the page decodes it: a page in a browser finds
 * nothing there, and the desktop app's page finds its state and two calls.
 */
export const HostedBridge = Schema.Struct({
  state: DesktopState,
  connect: Callable,
  forgetServer: Callable,
});
export type HostedBridge = typeof HostedBridge.Type;
