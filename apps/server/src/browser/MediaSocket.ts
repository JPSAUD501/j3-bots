// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the socket buffer's size is read from Node's own socket.
import type * as NodeStream from "node:stream";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  BROWSER_CLOSE_CODES,
  BrowserClientFrame,
  BrowserServerFrame,
  BrowserViewQuery,
  HTTP_PATHS,
  NotAuthenticated,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { credentialOf } from "../RpcSocket.ts";
import {
  BrowserViewers,
  type ClientLink,
  DEFAULT_VIEW_SIZE,
  LinkClosed,
} from "./BrowserViewers.ts";

/**
 * How far a client may fall behind: past this many bytes waiting in its
 * socket, it is dropped. One picture is in flight at a time, so only a client
 * that stopped reading gets here.
 */
const MAX_SOCKET_BUFFER_BYTES = 2 * 1024 * 1024;

/** A WebSocket frame's header, at most. */
const FRAME_OVERHEAD = 14;

const decodeClientFrame = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserClientFrame));
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(BrowserServerFrame));
const decodeQuery = Schema.decodeUnknownOption(BrowserViewQuery);

const refuse = HttpServerResponse.jsonUnsafe(new NotAuthenticated(), { status: 401 });

/** The query's own parameters, without the credential. */
const queryOf = (request: HttpServerRequest.HttpServerRequest) => {
  const params = new URL(request.url, "http://localhost").searchParams;
  return Object.fromEntries([...params].filter(([name]) => name !== "ticket"));
};

/** Node's socket under an upgrade, whose write buffer bounds what a client may owe. */
const transportOf = (request: HttpServerRequest.HttpServerRequest): NodeStream.Duplex | null => {
  const incoming = NodeHttpServerRequest.toIncomingMessage(request);
  return "socket" in incoming ? incoming.socket : null;
};

/** The client's end of an upgraded socket. Frames that do not decode are dropped unread. */
const linkOf = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  transport: NodeStream.Duplex | null,
) {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  const drop = Effect.sync(() => transport?.destroy()).pipe(
    Effect.andThen(Effect.fail(new LinkClosed())),
  );
  const send = (message: Uint8Array | BrowserServerFrame) =>
    Effect.suspend(() => {
      const data = message instanceof Uint8Array ? message : encodeServerFrame(message);
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if ((transport?.writableLength ?? 0) + bytes + FRAME_OVERHEAD > MAX_SOCKET_BUFFER_BYTES) {
        return drop;
      }
      return writer.write(data).pipe(Effect.mapError(() => new LinkClosed()));
    });
  const incoming = Stream.fromEffectRepeat(reader.pull).pipe(
    Stream.flatMap((chunks) => Stream.fromIterable(chunks)),
    Stream.filterMap((chunk) =>
      typeof chunk === "string"
        ? Result.fromOption(decodeClientFrame(chunk), () => undefined)
        : Result.failVoid,
    ),
    Stream.catchCause(() => Stream.empty),
  );
  return {
    send,
    close: (code, reason) => writer.write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore),
    incoming,
  } satisfies ClientLink;
});

/**
 * The media socket at `HTTP_PATHS.browser`, authenticated as the RPC socket
 * is, before the upgrade: a device token as a bearer or a one-use ticket. The
 * client gate's `Host` check runs before it, as before every route. Nothing a
 * socket carries is logged: not a picture, not what is typed.
 */
export const route = HttpRouter.add(
  "GET",
  HTTP_PATHS.browser,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* DeviceAuth;
    const viewers = yield* BrowserViewers;
    const credential = credentialOf(request);
    if (Option.isNone(credential)) return refuse;
    const device = yield* auth.authenticate(credential.value).pipe(Effect.option);
    if (Option.isNone(device)) return refuse;
    if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
      return HttpServerResponse.empty({ status: 426 });
    }
    const query = decodeQuery(queryOf(request));
    const transport = transportOf(request);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const link = yield* linkOf(yield* request.upgrade, transport);
        if (Option.isNone(query)) {
          return yield* link.close(BROWSER_CLOSE_CODES.invalid, "invalid");
        }
        yield* viewers.connect({
          deviceId: device.value,
          ref: query.value.ref,
          size: {
            maxWidth: query.value.maxWidth ?? DEFAULT_VIEW_SIZE.maxWidth,
            maxHeight: query.value.maxHeight ?? DEFAULT_VIEW_SIZE.maxHeight,
            quality: query.value.quality ?? DEFAULT_VIEW_SIZE.quality,
          },
          link,
        });
      }),
    ).pipe(Effect.ignore);
    return HttpServerResponse.empty();
  }),
);
