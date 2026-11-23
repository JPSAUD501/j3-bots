// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DeviceToken,
  UPDATE_API_VERSION,
  UPDATE_HTTP_PATHS,
  UpdateStatus,
} from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { make } from "./ServerUpdate.ts";

const encodeStatus = Schema.encodeSync(Schema.toCodecJson(UpdateStatus));

const at = DateTime.makeUnsafe("2026-11-24T12:00:00Z");
const TOKEN = DeviceToken.make("t".repeat(43));

/** A server on 0.3.1 that is offered 0.3.2, in `state`, its last update `lastResult`. */
const status = (
  state: UpdateStatus["state"],
  lastResult: UpdateStatus["lastResult"] = null,
  more: Partial<UpdateStatus> = {},
): unknown =>
  encodeStatus({
    api: UPDATE_API_VERSION,
    current: { version: "0.3.1", channel: "stable" },
    channel: "stable",
    available: {
      version: "0.3.2",
      channel: "stable",
      publishedAt: at,
      notesUrl: "https://example.test/releases/tag/v0.3.2",
      verified: true,
    },
    waitingForStable: false,
    refused: null,
    lastCheck: null,
    canUpdate: { _tag: "able" },
    state,
    run: null,
    lastResult,
    ...more,
  });

/** What one request to a route gets: an answer, or no answer at all, as from a server restarting. */
type Reply = { readonly status: number; readonly body?: unknown } | "no-answer";

/**
 * A server whose update routes give their replies in turn, the last one
 * again once they run out. A route not listed answers 404.
 */
const fakeServer = (routes: Readonly<Record<string, ReadonlyArray<Reply>>>) => {
  const asked = new Map<string, number>();
  const authorizations = new Set<string>();
  const http = HttpClient.make((request, url) => {
    authorizations.add(request.headers["authorization"] ?? "");
    const replies = routes[url.pathname] ?? [{ status: 404 }];
    const count = asked.get(url.pathname) ?? 0;
    asked.set(url.pathname, count + 1);
    const reply = replies[Math.min(count, replies.length - 1)] ?? { status: 404 };
    if (reply === "no-answer") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        reply.body === undefined
          ? new Response(null, { status: reply.status })
          : Response.json(reply.body, { status: reply.status }),
      ),
    );
  });
  return { http, authorizations };
};

const setUp = (routes: Readonly<Record<string, ReadonlyArray<Reply>>>) =>
  Effect.gen(function* () {
    const server = fakeServer(routes);
    let reconnects = 0;
    const update = yield* make({
      origin: new URL("http://server.test"),
      http: server.http,
      requestTimeout: Duration.seconds(10),
      token: Effect.succeed(Redacted.make(TOKEN)),
      reconnect: Effect.sync(() => {
        reconnects += 1;
      }),
    });
    return { update, authorizations: server.authorizations, reconnects: () => reconnects };
  });

describe("updating the server from a client", () => {
  it.effect("follows an update through the server's restart to its result, then reconnects", () =>
    Effect.gen(function* () {
      const { update, authorizations, reconnects } = yield* setUp({
        [UPDATE_HTTP_PATHS.start]: [
          { status: 202, body: status({ _tag: "downloading", receivedBytes: 0, totalBytes: 100 }) },
        ],
        [UPDATE_HTTP_PATHS.status]: [
          "no-answer",
          "no-answer",
          {
            status: 200,
            body: status(
              { _tag: "rolled-back", reason: "health-check" },
              {
                outcome: "rolled-back",
                from: "0.3.1",
                to: "0.3.2",
                at,
                by: null,
                reason: "health-check",
                detail: null,
              },
            ),
          },
        ],
      });
      assert.deepStrictEqual(yield* update.start("0.3.2", false), { _tag: "started" });

      yield* TestClock.adjust(Duration.seconds(2));
      const restarting = update.view.get();
      assert.deepStrictEqual(
        restarting._tag === "restarting" ? restarting.to : restarting._tag,
        "0.3.2",
      );
      assert.isNull(update.ended.get());
      assert.strictEqual(reconnects(), 0);

      yield* TestClock.adjust(Duration.seconds(4));
      assert.strictEqual(update.view.get()._tag, "status");
      assert.strictEqual(update.ended.get()?.outcome, "rolled-back");
      assert.strictEqual(reconnects(), 1);
      assert.deepStrictEqual([...authorizations], [`Bearer ${TOKEN}`]);

      yield* update.dismissEnded;
      assert.isNull(update.ended.get());
    }).pipe(Effect.scoped),
  );

  it.effect("stops saying the server is restarting after ten minutes without an answer", () =>
    Effect.gen(function* () {
      // Read mid-run, from another device's start: the offer is gone, the run's target stays.
      const midRun = status({ _tag: "restarting" }, null, {
        available: null,
        run: { from: "0.3.1", to: "0.3.2", by: null, startedAt: at },
      });
      const { update, reconnects } = yield* setUp({
        [UPDATE_HTTP_PATHS.status]: [{ status: 200, body: midRun }, "no-answer"],
      });
      yield* update.refresh;
      yield* TestClock.adjust(Duration.minutes(9));
      const restarting = update.view.get();
      assert.deepStrictEqual(
        restarting._tag === "restarting" ? restarting.to : restarting._tag,
        "0.3.2",
      );
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual(update.view.get()._tag, "lost");
      assert.strictEqual(reconnects(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("passes on how many bots are at work when the server refuses for them", () =>
    Effect.gen(function* () {
      const { update } = yield* setUp({
        [UPDATE_HTTP_PATHS.start]: [
          { status: 409, body: { _tag: "UpdateRefused", reason: "work-running", runningBots: 2 } },
        ],
        [UPDATE_HTTP_PATHS.status]: [{ status: 200, body: status({ _tag: "idle" }) }],
      });
      assert.deepStrictEqual(yield* update.start("0.3.2", false), {
        _tag: "refused",
        reason: "work-running",
        runningBots: 2,
      });
      assert.strictEqual(update.view.get()._tag, "status");
    }).pipe(Effect.scoped),
  );

  it.effect("tells a server without the update routes from one that does not answer", () =>
    Effect.gen(function* () {
      const old = yield* setUp({});
      yield* old.update.refresh;
      assert.strictEqual(old.update.view.get()._tag, "unsupported");
      assert.deepStrictEqual(yield* old.update.start("0.3.2", false), { _tag: "unsupported" });

      const away = yield* setUp({ [UPDATE_HTTP_PATHS.status]: ["no-answer"] });
      yield* away.update.refresh;
      assert.deepStrictEqual(away.update.view.get(), { _tag: "unreachable", last: null });
    }).pipe(Effect.scoped),
  );
});
