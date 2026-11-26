// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { type BotId, HTTP_PATHS, type WorkStep, WorkStepId } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { BotStore } from "../bots/BotStore.ts";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  createBot,
  engineSession,
  eventually,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import * as TestUpdates from "../testing/update.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import * as RefusedNames from "../web/RefusedNames.ts";
import * as WebClient from "../web/WebClient.ts";
import { imageTypeOf } from "./WorkImages.ts";

const server = Ports.serve(Http.app, NodeHttpServer.layerTest, { logAddress: false }).pipe(
  Layer.provide([WebClient.statusLayer, RefusedNames.layer, TestUpdates.layer]),
  Layer.provideMerge(TestDomain.layer),
);

const pairedToken = Effect.gen(function* () {
  const devices = yield* Devices;
  const { code } = yield* devices.startPairing;
  return (yield* devices.pair({ code, name: "Laptop" })).token;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** The fold's steps as a client is sent them. */
const stepsOf = (botId: BotId) =>
  Effect.gen(function* () {
    const fold = yield* awaitEntry(botId, "work-fold");
    const frames = yield* (yield* WorkSteps)
      .follow(fold.id)
      .pipe(Stream.take(1), Stream.runCollect);
    return frames.flatMap((frame) => (frame._tag === "snapshot" ? frame.steps : [frame.step]));
  });

/** A bot at work whose turn looks at `given`, once `files/` holds what `write` puts there. */
const lookingAt = (
  given: (workspace: string) => string,
  write: (files: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "What does the chart say?");
    const turnId = yield* nextTurn(bot.id);
    const workspace = Option.getOrThrow(yield* (yield* BotStore).find(bot.id)).workspacePath;
    const files = path.join(workspace, "files");
    yield* fs.makeDirectory(files, { recursive: true });
    yield* write(files).pipe(Effect.orDie);
    const at = yield* DateTime.now;
    yield* control.step({
      sessionId: session,
      turnId,
      step: {
        id: WorkStepId.make("step-look"),
        kind: "tool",
        tool: "image",
        label: "Looked at an image",
        status: "completed",
        startedAt: at,
        finishedAt: at,
        viewedImage: given(workspace),
      },
    });
    const step = yield* eventually(
      stepsOf(bot.id).pipe(Effect.map((found) => Option.fromNullishOr(found[0]))),
    );
    return { bot, files, step };
  });

const fetchImage = (step: WorkStep, token: string | null) =>
  HttpClientRequest.get(`${HTTP_PATHS.workImages}/${step.image?.id ?? "none"}`).pipe(
    token === null ? (request) => request : HttpClientRequest.bearerToken(token),
    HttpClient.execute,
  );

it.effect("names the image by an id and serves it to a paired device, typed by its bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const token = yield* pairedToken;
    const { step } = yield* lookingAt(
      (workspace) => path.join(workspace, "files", "chart.png"),
      (files) => fs.writeFile(path.join(files, "chart.png"), PNG),
    );

    assert.isDefined(step.image);
    // The path stays on the server.
    assert.notInclude(JSON.stringify(step), "chart.png");
    const served = yield* fetchImage(step, token);
    assert.strictEqual(served.status, 200);
    assert.strictEqual(served.headers["content-type"], "image/png");
    assert.deepStrictEqual(new Uint8Array(yield* served.arrayBuffer), PNG);
    assert.strictEqual((yield* fetchImage(step, null)).status, 401);
  }).pipe(Effect.provide(server)),
);

it.effect("serves the file as it is now: nothing once it is gone or no longer an image", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const token = yield* pairedToken;
    const { files, step } = yield* lookingAt(
      () => "files/shot.webp",
      (folder) => fs.writeFile(path.join(folder, "shot.webp"), PNG),
    );
    assert.isDefined(step.image);
    // Named `.webp`, it holds a PNG: it is served as what it holds.
    assert.strictEqual((yield* fetchImage(step, token)).headers["content-type"], "image/png");

    yield* fs.writeFileString(path.join(files, "shot.webp"), "<svg onload='alert(1)'/>");
    assert.strictEqual((yield* fetchImage(step, token)).status, 404);
    yield* fs.remove(path.join(files, "shot.webp"));
    assert.strictEqual((yield* fetchImage(step, token)).status, 404);
  }).pipe(Effect.provide(server)),
);

it.effect("names no image the step looked at outside the workspace", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const elsewhere = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFile(path.join(elsewhere, "private.png"), PNG);
    const { step } = yield* lookingAt(
      () => path.join(elsewhere, "private.png"),
      () => Effect.void,
    );
    assert.isUndefined(step.image);
  }).pipe(Effect.scoped, Effect.provide(server)),
);

it.effect("names no image the step looked at through a link that leads out of the workspace", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const elsewhere = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFile(path.join(elsewhere, "private.png"), PNG);
    const { step } = yield* lookingAt(
      () => "files/linked.png",
      (files) => fs.symlink(path.join(elsewhere, "private.png"), path.join(files, "linked.png")),
    );
    assert.isUndefined(step.image);
  }).pipe(Effect.scoped, Effect.provide(server)),
);

it("tells an image's type from its first bytes, never from its name", () => {
  const bytes = (...parts: ReadonlyArray<string | ReadonlyArray<number>>) =>
    new Uint8Array(
      parts.flatMap((part) =>
        typeof part === "string"
          ? [...part].map((character) => character.charCodeAt(0))
          : [...part],
      ),
    );
  assert.strictEqual(imageTypeOf(PNG), "image/png");
  assert.strictEqual(imageTypeOf(bytes([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.strictEqual(imageTypeOf(bytes("GIF89a")), "image/gif");
  assert.strictEqual(imageTypeOf(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")), "image/webp");
  assert.strictEqual(imageTypeOf(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), undefined);
  assert.strictEqual(imageTypeOf(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined);
  assert.strictEqual(imageTypeOf(bytes([0x89, 0x50])), undefined);
});
