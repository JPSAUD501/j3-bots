// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as TestClock from "effect/testing/TestClock";
import { upload } from "./upload.ts";

it.effect("gives up on an upload the engine never answers, after a deadline its size extends", () =>
  Effect.gen(function* () {
    const stalled = HttpClient.make(() => Effect.never);
    const size = 10 * 1024 * 1024;
    const fiber = yield* upload(stalled, HttpClientRequest.post("http://127.0.0.1:1/upload"), {
      size,
      commandTimeout: Duration.seconds(30),
    }).pipe(Effect.flip, Effect.forkChild);

    // A command's time is not enough for ten MiB.
    yield* TestClock.adjust("30 seconds");
    assert.isUndefined(fiber.pollUnsafe());

    // A second per MiB on top is.
    yield* TestClock.adjust("10 seconds");
    const error = yield* Fiber.join(fiber);
    assert.strictEqual(error._tag, "EngineIndeterminate");
  }),
);
