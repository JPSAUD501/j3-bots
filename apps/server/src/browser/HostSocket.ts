// SPDX-License-Identifier: AGPL-3.0-or-later
import { pageHostOnSocket } from "@j3-bots/browser";
import { HTTP_PATHS, NotAuthenticated } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { credentialOf } from "../RpcSocket.ts";
import { Browser } from "./Browser.ts";

const refuse = HttpServerResponse.jsonUnsafe(new NotAuthenticated(), { status: 401 });

/**
 * The page host socket at `HTTP_PATHS.browserHost` (decision 0110): a
 * desktop app's own browser dials it with its device token as a bearer, and
 * the server drives that browser over it for as long as it stays open. A
 * host that says it is anything but the desktop of the device the token
 * belongs to is closed before any of its tabs is listed; so is one whose
 * device is revoked. Nothing the socket carries is logged.
 */
export const route = HttpRouter.add(
  "GET",
  HTTP_PATHS.browserHost,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* DeviceAuth;
    const browser = yield* Browser;
    // A bearer only: a ticket is for the browser's own sockets, which a page host is not.
    const credential = credentialOf(request).pipe(
      Option.filter((found) => found._tag === "bearer"),
    );
    if (Option.isNone(credential)) return refuse;
    const device = yield* auth.authenticate(credential.value).pipe(Effect.option);
    if (Option.isNone(device)) return refuse;
    if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
      return HttpServerResponse.empty({ status: 426 });
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { host } = yield* pageHostOnSocket(yield* request.upgrade);
        const hello = yield* host.hello;
        if (hello.host.kind !== "desktop" || hello.host.device !== device.value) {
          return yield* Effect.logWarning("A browser host said it was another computer's");
        }
        const attached = yield* browser.attachHost(host);
        yield* Effect.raceFirst(attached.ended, auth.revoked(device.value));
      }),
    ).pipe(Effect.ignore);
    return HttpServerResponse.empty();
  }),
);
