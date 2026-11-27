// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BROWSER_DOWNLOAD_CHUNK_BYTES,
  type BrowserActOutcome,
  type BrowserCookie,
  type BrowserCookieChanges,
  type BrowserEvaluation,
  type BrowserFillResult,
  BrowserHostError,
  type BrowserHostEvent,
  type BrowserHostHello,
  BrowserHostRpcs,
  type BrowserImage,
  type BrowserOriginStorage,
  type BrowserPageSnapshot,
  type BrowserPageState,
  type BrowserScreencastFrame,
  type BrowserTabRef,
  MAX_ATTACHMENT_SIZE,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";
import type { DriverPage } from "./driver/DriverPage.ts";

/** The page host protocol's calls, as one union. */
export type BrowserHostRpc = RpcGroup.Rpcs<typeof BrowserHostRpcs>;

/** What a page host call takes, by its name in the protocol. */
export type PageHostPayload<Tag extends BrowserHostRpc["_tag"]> = Rpc.Payload<
  Rpc.ExtractTag<BrowserHostRpc, Tag>
>;

/**
 * A browser that runs tabs for the J3 Bots server (decision 0110): the
 * desktop app's own browser or the server's. One method per call of
 * `BrowserHostRpcs`, so the server drives a host in its own process and one
 * across a connection alike.
 */
export interface PageHost {
  readonly hello: Effect.Effect<BrowserHostHello, BrowserHostError>;
  readonly events: Stream.Stream<BrowserHostEvent, BrowserHostError>;
  readonly open: (
    input: PageHostPayload<"tab.open">,
  ) => Effect.Effect<BrowserPageState, BrowserHostError>;
  readonly close: (tab: BrowserTabRef) => Effect.Effect<void, BrowserHostError>;
  readonly navigate: (
    input: PageHostPayload<"tab.navigate">,
  ) => Effect.Effect<BrowserPageState, BrowserHostError>;
  readonly snapshot: (
    input: PageHostPayload<"tab.snapshot">,
  ) => Effect.Effect<BrowserPageSnapshot, BrowserHostError>;
  readonly act: (
    input: PageHostPayload<"tab.act">,
  ) => Effect.Effect<BrowserActOutcome, BrowserHostError>;
  readonly evaluate: (
    input: PageHostPayload<"tab.evaluate">,
  ) => Effect.Effect<BrowserEvaluation, BrowserHostError>;
  readonly waitFor: (
    input: PageHostPayload<"tab.waitFor">,
  ) => Effect.Effect<void, BrowserHostError>;
  readonly dialog: (input: PageHostPayload<"tab.dialog">) => Effect.Effect<void, BrowserHostError>;
  readonly screenshot: (
    input: PageHostPayload<"tab.screenshot">,
  ) => Effect.Effect<BrowserImage, BrowserHostError>;
  readonly screencast: (
    input: PageHostPayload<"tab.screencast">,
  ) => Stream.Stream<BrowserScreencastFrame, BrowserHostError>;
  readonly screencastAck: (
    input: PageHostPayload<"tab.screencastAck">,
  ) => Effect.Effect<void, BrowserHostError>;
  readonly input: (input: PageHostPayload<"tab.input">) => Effect.Effect<void, BrowserHostError>;
  readonly probe: (
    input: PageHostPayload<"tab.probe">,
  ) => Effect.Effect<{ readonly editable: boolean }, BrowserHostError>;
  readonly putFile: (
    input: PageHostPayload<"files.put">,
  ) => Effect.Effect<{ readonly path: string }, BrowserHostError>;
  readonly takeDownload: (
    input: PageHostPayload<"download.take">,
  ) => Effect.Effect<{ readonly bytes: Uint8Array }, BrowserHostError>;
  readonly fill: (
    input: PageHostPayload<"tab.fill">,
  ) => Effect.Effect<BrowserFillResult, BrowserHostError>;
  readonly readCookies: Effect.Effect<
    { readonly cookies: ReadonlyArray<BrowserCookie> },
    BrowserHostError
  >;
  readonly writeCookies: (changes: BrowserCookieChanges) => Effect.Effect<void, BrowserHostError>;
  readonly readStorage: (
    input: PageHostPayload<"storage.read">,
  ) => Effect.Effect<{ readonly origins: ReadonlyArray<BrowserOriginStorage> }, BrowserHostError>;
  readonly writeStorage: (
    origins: ReadonlyArray<BrowserOriginStorage>,
  ) => Effect.Effect<void, BrowserHostError>;
  readonly clearStorage: (
    clear: PageHostPayload<"storage.clear">["clear"],
  ) => Effect.Effect<void, BrowserHostError>;
}

/** The calls of a page host that are page work on a tab it holds. */
export type PageHostTabCalls = Pick<
  PageHost,
  | "navigate"
  | "snapshot"
  | "act"
  | "evaluate"
  | "waitFor"
  | "dialog"
  | "screenshot"
  | "screencast"
  | "screencastAck"
  | "input"
  | "probe"
  | "fill"
>;

const noTab = Effect.fail(new BrowserHostError({ reason: "no-tab" }));

/**
 * The page work of a host whose tabs are `DriverPage`s, which both hosts'
 * are: each call finds the tab's driver in `tabs` and runs there. A host
 * adds the calls it answers in its own way: hello, events, opening and
 * closing tabs, and sign-ins. `pointer` hears where a bot's action points.
 */
export const driverTabCalls = (
  tabs: ReadonlyMap<BrowserTabRef, DriverPage>,
  pointer: (event: Extract<BrowserHostEvent, { readonly type: "pointer" }>) => Effect.Effect<void>,
): PageHostTabCalls => {
  const on = <A>(
    tab: BrowserTabRef,
    run: (driver: DriverPage) => Effect.Effect<A, BrowserHostError>,
  ): Effect.Effect<A, BrowserHostError> =>
    Effect.suspend(() => {
      const driver = tabs.get(tab);
      return driver === undefined ? noTab : run(driver);
    });
  return {
    navigate: ({ tab, to, readiness, timeoutMs }) =>
      on(tab, (driver) => driver.navigate(to, { readiness, timeoutMs })),
    snapshot: ({ tab, includeImage }) => on(tab, (driver) => driver.snapshot({ includeImage })),
    act: ({ tab, action }) =>
      on(tab, (driver) =>
        driver.act(action, (point, kind) =>
          pointer({ type: "pointer", tab, action: kind, ...point }),
        ),
      ),
    evaluate: ({ tab, expression, awaitPromise, timeoutMs }) =>
      on(tab, (driver) => driver.evaluate({ expression, awaitPromise, timeoutMs })),
    waitFor: ({ tab, condition }) => on(tab, (driver) => driver.waitFor(condition)),
    dialog: ({ tab, accept, promptText }) =>
      on(tab, (driver) => driver.answerDialog(accept, promptText)),
    screenshot: ({ tab, format, quality }) =>
      on(tab, (driver) => driver.screenshot({ format, quality })),
    screencast: ({ tab, maxWidth, maxHeight, quality }) =>
      Stream.unwrap(
        Effect.sync(() => {
          const driver = tabs.get(tab);
          return driver === undefined
            ? Stream.fail(new BrowserHostError({ reason: "no-tab" }))
            : driver.screencast({ maxWidth, maxHeight, quality });
        }),
      ),
    screencastAck: ({ tab, frame }) => on(tab, (driver) => driver.screencastAck(frame)),
    input: ({ tab, input }) => on(tab, (driver) => driver.input(input)),
    probe: ({ tab, x, y }) =>
      on(tab, (driver) => Effect.map(driver.probe(x, y), (editable) => ({ editable }))),
    fill: ({ tab, ...request }) => on(tab, (driver) => driver.fill(request)),
  };
};

/** The handlers that answer `BrowserHostRpcs` with `host`, for the side that runs the browser. */
export const pageHostHandlers = (host: PageHost) =>
  BrowserHostRpcs.toLayer({
    "host.hello": () => host.hello,
    "host.events": () => host.events,
    "tab.open": (input) => host.open(input),
    "tab.close": ({ tab }) => host.close(tab),
    "tab.navigate": (input) => host.navigate(input),
    "tab.snapshot": (input) => host.snapshot(input),
    "tab.act": (input) => host.act(input),
    "tab.evaluate": (input) => host.evaluate(input),
    "tab.waitFor": (input) => host.waitFor(input),
    "tab.dialog": (input) => host.dialog(input),
    "tab.screenshot": (input) => host.screenshot(input),
    "tab.screencast": (input) => host.screencast(input),
    "tab.screencastAck": (input) => host.screencastAck(input),
    "tab.input": (input) => host.input(input),
    "tab.probe": (input) => host.probe(input),
    "files.put": (input) => host.putFile(input),
    "download.take": (input) =>
      Stream.unwrap(Effect.map(host.takeDownload(input), ({ bytes }) => chunksOf(bytes))),
    "tab.fill": (input) => host.fill(input),
    "cookies.read": () => host.readCookies,
    "cookies.write": ({ changes }) => host.writeCookies(changes),
    "storage.read": (input) => host.readStorage(input),
    "storage.write": ({ origins }) => host.writeStorage(origins),
    "storage.clear": ({ clear }) => host.clearStorage(clear),
  });

/** A host's client, as the server holds one: a call the connection loses fails as `closed`. */
export type PageHostClient = RpcClient.RpcClient<BrowserHostRpc, RpcClientError.RpcClientError>;

/** A download's bytes as `download.take` sends them, a chunk to a message. */
const chunksOf = (bytes: Uint8Array) =>
  Stream.fromIterable(
    Array.from({ length: Math.ceil(bytes.length / BROWSER_DOWNLOAD_CHUNK_BYTES) }, (_, index) =>
      bytes.subarray(
        index * BROWSER_DOWNLOAD_CHUNK_BYTES,
        (index + 1) * BROWSER_DOWNLOAD_CHUNK_BYTES,
      ),
    ),
  );

const sizeOf = (chunks: ReadonlyArray<Uint8Array>) =>
  chunks.reduce((total, chunk) => total + chunk.length, 0);

const joined = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(sizeOf(chunks));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

/** A host that sends more of a download than an attachment may hold. */
const tooLarge = Effect.fail(
  new BrowserHostError({
    reason: "too-large",
    detail: "The download is larger than an attachment.",
  }),
);

const lost = (cause: RpcClientError.RpcClientError) =>
  Effect.fail(new BrowserHostError({ reason: "closed", detail: cause.message.slice(0, 500) }));

/** The host at the other end of `client`, for the server. */
export const remotePageHost = (client: PageHostClient): PageHost => ({
  hello: client["host.hello"]().pipe(Effect.catchTag("RpcClientError", lost)),
  events: client["host.events"]().pipe(
    Stream.catchTag("RpcClientError", (cause) => Stream.fromEffect(lost(cause))),
  ),
  open: (input) => client["tab.open"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  close: (tab) => client["tab.close"]({ tab }).pipe(Effect.catchTag("RpcClientError", lost)),
  navigate: (input) => client["tab.navigate"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  snapshot: (input) => client["tab.snapshot"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  act: (input) => client["tab.act"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  evaluate: (input) => client["tab.evaluate"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  waitFor: (input) => client["tab.waitFor"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  dialog: (input) => client["tab.dialog"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  screenshot: (input) =>
    client["tab.screenshot"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  screencast: (input) =>
    client["tab.screencast"](input).pipe(
      Stream.catchTag("RpcClientError", (cause) => Stream.fromEffect(lost(cause))),
    ),
  screencastAck: (input) =>
    client["tab.screencastAck"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  input: (input) => client["tab.input"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  probe: (input) => client["tab.probe"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  putFile: (input) => client["files.put"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  takeDownload: (input) =>
    client["download.take"](input).pipe(
      Stream.runFoldEffect(
        (): Array<Uint8Array> => [],
        (chunks, chunk) => {
          chunks.push(chunk);
          return sizeOf(chunks) <= MAX_ATTACHMENT_SIZE ? Effect.succeed(chunks) : tooLarge;
        },
      ),
      Effect.map((chunks) => ({ bytes: joined(chunks) })),
      Effect.catchTag("RpcClientError", lost),
    ),
  fill: (input) => client["tab.fill"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  readCookies: client["cookies.read"]().pipe(Effect.catchTag("RpcClientError", lost)),
  writeCookies: (changes) =>
    client["cookies.write"]({ changes }).pipe(Effect.catchTag("RpcClientError", lost)),
  readStorage: (input) =>
    client["storage.read"](input).pipe(Effect.catchTag("RpcClientError", lost)),
  writeStorage: (origins) =>
    client["storage.write"]({ origins }).pipe(Effect.catchTag("RpcClientError", lost)),
  clearStorage: (clear) =>
    client["storage.clear"]({ clear }).pipe(Effect.catchTag("RpcClientError", lost)),
});
