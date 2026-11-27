// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  HTTP_PATHS,
  NotAuthenticated,
  VoiceClientFrame,
  VoiceServerFrame,
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
import { LinkClosed, Voice, type VoiceLink } from "./Voice.ts";

const decodeClientFrame = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceClientFrame));
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(VoiceServerFrame));

const refuse = HttpServerResponse.jsonUnsafe(new NotAuthenticated(), { status: 401 });

/** The socket closes normally once the dictation ends, as a policy close when its device is revoked. */
const CLOSE_CODES = { done: 1000, revoked: 1008 } as const;

/** The client's end of an upgraded socket. A text frame that does not decode is dropped unread. */
const linkOf = Effect.fnUntraced(function* (socket: Socket.Socket) {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  const link: VoiceLink = {
    send: (frame) =>
      writer.write(encodeServerFrame(frame)).pipe(Effect.mapError(() => new LinkClosed())),
    incoming: Stream.fromEffectRepeat(reader.pull).pipe(
      Stream.flatMap((chunks) => Stream.fromIterable(chunks)),
      Stream.filterMap((chunk): Result.Result<VoiceClientFrame | Uint8Array, undefined> =>
        typeof chunk === "string"
          ? Result.fromOption(decodeClientFrame(chunk), () => undefined)
          : Result.succeed(chunk),
      ),
      Stream.catchCause(() => Stream.empty),
    ),
  };
  return {
    link,
    close: (code: number) => writer.write(new Socket.CloseEvent(code)).pipe(Effect.ignore),
  };
});

/**
 * The voice socket at `HTTP_PATHS.voice`, authenticated as the RPC socket is,
 * before the upgrade: a device token as a bearer or a one-use ticket. One
 * socket is one dictation (`Voice.dictate`), which ends when its device is
 * revoked. Nothing it carries is logged or kept: not the audio, not the words.
 */
export const route = HttpRouter.add(
  "GET",
  HTTP_PATHS.voice,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* DeviceAuth;
    const voice = yield* Voice;
    const credential = credentialOf(request);
    if (Option.isNone(credential)) return refuse;
    const device = yield* auth.authenticate(credential.value).pipe(Effect.option);
    if (Option.isNone(device)) return refuse;
    if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
      return HttpServerResponse.empty({ status: 426 });
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { link, close } = yield* linkOf(yield* request.upgrade);
        yield* Effect.raceFirst(
          voice.dictate(link).pipe(Effect.andThen(close(CLOSE_CODES.done))),
          auth.revoked(device.value).pipe(Effect.andThen(close(CLOSE_CODES.revoked))),
        );
      }),
    ).pipe(Effect.ignore);
    return HttpServerResponse.empty();
  }),
);
