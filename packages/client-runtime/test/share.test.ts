// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, type EntryTarget, HTTP_PATHS } from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ClientRuntime from "../src/client.ts";
import { waitFor } from "../src/Store.ts";
import type { ConversationItem } from "../src/stores/Conversations.ts";
import * as TestPlatform from "./platform.ts";

// What a share from another app does with the app's client: its files
// uploaded one after another, then one message with them.

const server = Server.layer(Layer.empty);

/** A server that refuses every upload, as one whose attachments folder was linked out of its data. */
const refusingUploads = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const real = yield* HttpClient.HttpClient;
    return HttpClient.make((request, url) =>
      url.pathname === HTTP_PATHS.attachments
        ? Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ _tag: "Conflict", reason: "private-location" }, { status: 409 }),
            ),
          )
        : real.execute(request),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

/** An app's client, paired, with a bot to send to. */
const pairedApp = (http?: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    const origin = yield* Server.origin;
    const { code } = yield* (yield* Server.Devices).startPairing;
    const app = yield* Effect.acquireRelease(
      Effect.promise(() =>
        ClientRuntime.createJ3Client(
          TestPlatform.layer(origin, Option.none(), TestPlatform.makeDevice(), http),
        ),
      ),
      (opened) => Effect.promise(() => opened.dispose()),
    );
    const paired = yield* Effect.promise(() => app.pair({ code, deviceName: "Phone" }));
    assert.strictEqual(paired._tag, "paired");
    const commandId = yield* Effect.promise(() => app.commandId());
    const created = yield* Effect.promise(() =>
      app.call((rpc) => rpc["bot.create"]({ commandId, name: "Reader" })),
    );
    if (created._tag !== "Success") return yield* Effect.die("The bot was not created");
    const botId: BotId = created.value.id;
    const target: EntryTarget = { _tag: "conversation", botId };
    return { app, target };
  });

/** A signal no one aborts. */
const going = () => new AbortController().signal;

/** A signal already aborted, as Stop pressed before anything went. */
const stopped = () => {
  const stopping = new AbortController();
  stopping.abort();
  return stopping.signal;
};

/** The share's message, sent or on its way; the bot's own hello is not it. */
const isTheShare = (item: ConversationItem) =>
  (item._tag === "message" || item._tag === "outgoing") && item.text === "Have a look";

const files = [
  { name: "notes.txt", body: new Blob(["first notes"], { type: "text/plain" }) },
  { name: "more.txt", body: new Blob(["more"], { type: "text/plain" }) },
];

it.layer(server, { excludeTestServices: true })("sending a share", (it) => {
  it.effect("uploads each file, then sends one message that carries them", () =>
    Effect.gen(function* () {
      const { app, target } = yield* pairedApp();
      const progress: Array<readonly [number, number]> = [];
      const sent = yield* Effect.promise(() =>
        app.sendWithFiles(
          {
            target,
            text: "Have a look",
            files,
            onProgress: (done, total) => progress.push([done, total]),
          },
          going(),
        ),
      );
      if (sent._tag !== "done") return yield* Effect.die(`Not sent: ${sent._tag}`);
      const total = files.reduce((sum, file) => sum + file.body.size, 0);
      assert.deepStrictEqual(progress.at(-1), [total, total]);

      const conversation = app.openConversation(target);
      const shown = yield* waitFor(conversation.state, (state) =>
        state.items.some((item) => item._tag === "message" && item.id === sent.value),
      );
      const message = shown.items.find((item) => item._tag === "message" && item.id === sent.value);
      assert.deepStrictEqual(
        message?._tag === "message"
          ? [message.text, message.attachments.map((attachment) => attachment.name)]
          : null,
        ["Have a look", ["notes.txt", "more.txt"]],
      );
      conversation.release();
    }).pipe(Effect.scoped),
  );

  it.effect("stops at a file the server refuses, and sends no message", () =>
    Effect.gen(function* () {
      const { app, target } = yield* pairedApp(refusingUploads);
      const sent = yield* Effect.promise(() =>
        app.sendWithFiles(
          { target, text: "Have a look", files, onProgress: () => undefined },
          going(),
        ),
      );
      assert.deepStrictEqual(sent, { _tag: "refused", index: 0, problem: "server-setup" });

      const conversation = app.openConversation(target);
      const loaded = yield* waitFor(conversation.state, (state) => state.phase === "ready");
      assert.isFalse(loaded.items.some(isTheShare));
      conversation.release();
    }).pipe(Effect.scoped),
  );

  it.effect("ends as stopped when the operator stops it, and sends no message", () =>
    Effect.gen(function* () {
      const { app, target } = yield* pairedApp();
      const sent = yield* Effect.promise(() =>
        app.sendWithFiles(
          { target, text: "Have a look", files, onProgress: () => undefined },
          stopped(),
        ),
      );
      assert.deepStrictEqual(sent, { _tag: "stopped" });

      const conversation = app.openConversation(target);
      const loaded = yield* waitFor(conversation.state, (state) => state.phase === "ready");
      assert.isFalse(loaded.items.some(isTheShare));
      conversation.release();
    }).pipe(Effect.scoped),
  );
});
