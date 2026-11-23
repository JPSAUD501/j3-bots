// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { UPDATE_HTTP_PATHS, UpdateRefused, UpdateStatus } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as WebClient from "../web/WebClient.ts";
import type { UpdateUnitPlan } from "./launch.ts";
import * as UpdateRuns from "./UpdateRuns.ts";

const OFFERED = "99.0.0";

/** The updates the server started. */
const launched: Array<UpdateUnitPlan> = [];

const updates = Layer.merge(
  TestUpdates.feedLayer(Effect.succeed(TestUpdates.feedStatus(Option.some(OFFERED)))),
  UpdateRuns.layer.pipe(
    Layer.provide(
      TestUpdates.launcherLayer(
        {
          _tag: "service",
          command: "/install/versions/current/bin/j3-bots",
          home: "/unused",
          searchPath: "/usr/bin",
          release: {},
        },
        launched,
      ),
    ),
  ),
);

/** Sends `request`, as the device whose token is `token` when one is given. */
const send = (request: HttpClientRequest.HttpClientRequest, token?: string) =>
  HttpClient.execute(
    token === undefined ? request : request.pipe(HttpClientRequest.bearerToken(token)),
  );

/** A POST to `path` with `body` as `contentType`. */
const post = (path: string, body: string, contentType = "application/json") =>
  HttpClientRequest.post(path).pipe(HttpClientRequest.bodyText(body, contentType));

const pairedToken = Effect.gen(function* () {
  const { token } = yield* (yield* Devices).mint("Phone");
  return token;
});

it.layer(
  Http.serve(NodeHttpServer.layerTest, { logAddress: false }).pipe(
    Layer.provide(WebClient.statusLayer),
    Layer.provide(updates),
    Layer.provideMerge(TestDomain.layer),
  ),
)("the update routes", (it) => {
  it.effect("answer a paired device, and no one else", () =>
    Effect.gen(function* () {
      const token = yield* pairedToken;
      const status = HttpClientRequest.get(UPDATE_HTTP_PATHS.status);
      assert.strictEqual((yield* send(status)).status, 401);
      assert.strictEqual((yield* send(status, "not-a-token")).status, 401);
      const start = post(
        UPDATE_HTTP_PATHS.start,
        JSON.stringify({ version: OFFERED, stopWork: true }),
      );
      assert.strictEqual((yield* send(start, "not-a-token")).status, 401);
      assert.deepStrictEqual(launched, []);

      const answered = yield* send(status, token);
      assert.strictEqual(answered.status, 200);
      const body = yield* HttpClientResponse.schemaBodyJson(UpdateStatus)(answered);
      assert.deepStrictEqual(body.canUpdate, { _tag: "able" });
      assert.strictEqual(body.available?.version, OFFERED);
    }),
  );

  it.effect("take a body only as JSON, and only a small one", () =>
    Effect.gen(function* () {
      const token = yield* pairedToken;
      const valid = JSON.stringify({ version: OFFERED, stopWork: true });
      const answer = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.map(send(request, token), ({ status }) => status);
      // A form or plain text is what a page elsewhere can send without asking first.
      assert.strictEqual(yield* answer(post(UPDATE_HTTP_PATHS.start, valid, "text/plain")), 415);
      assert.strictEqual(yield* answer(post(UPDATE_HTTP_PATHS.start, "{")), 400);
      assert.strictEqual(
        yield* answer(
          post(
            UPDATE_HTTP_PATHS.start,
            JSON.stringify({ version: OFFERED, pad: "x".repeat(2048) }),
          ),
        ),
        413,
      );
      assert.strictEqual(
        yield* answer(post(UPDATE_HTTP_PATHS.channel, JSON.stringify({ channel: "weekly" }))),
        400,
      );
      assert.deepStrictEqual(launched, []);
    }),
  );

  it.effect("start only the release the feed offers, one at a time", () =>
    Effect.gen(function* () {
      const token = yield* pairedToken;
      const start = (version: string) =>
        send(post(UPDATE_HTTP_PATHS.start, JSON.stringify({ version, stopWork: false })), token);
      const refusal = (response: HttpClientResponse.HttpClientResponse) =>
        Effect.map(HttpClientResponse.schemaBodyJson(UpdateRefused)(response), ({ reason }) => [
          response.status,
          reason,
        ]);

      assert.deepStrictEqual(yield* Effect.flatMap(start("98.0.0"), refusal), [
        409,
        "not-available",
      ]);
      // Right after the channel changed, the feed's offer is still the old channel's.
      const channel = (to: string) =>
        send(post(UPDATE_HTTP_PATHS.channel, JSON.stringify({ channel: to })), token);
      yield* channel("nightly");
      assert.deepStrictEqual(yield* Effect.flatMap(start(OFFERED), refusal), [
        409,
        "not-available",
      ]);
      yield* channel("stable");
      const started = yield* start(OFFERED);
      assert.strictEqual(started.status, 202);
      const status = yield* HttpClientResponse.schemaBodyJson(UpdateStatus)(started);
      assert.strictEqual(status.state._tag, "downloading");
      assert.strictEqual(status.run?.to, OFFERED);
      assert.deepStrictEqual(
        launched.map(({ version }) => version),
        [OFFERED],
      );
      assert.deepStrictEqual(yield* Effect.flatMap(start(OFFERED), refusal), [409, "busy"]);
    }),
  );

  it.effect("keep the channel a client chooses", () =>
    Effect.gen(function* () {
      const token = yield* pairedToken;
      const answered = yield* send(
        post(UPDATE_HTTP_PATHS.channel, JSON.stringify({ channel: "nightly" })),
        token,
      );
      assert.strictEqual(answered.status, 200);
      const saved = yield* (yield* SettingsService).get;
      assert.strictEqual(saved.updateChannel, "nightly");
    }),
  );
});
