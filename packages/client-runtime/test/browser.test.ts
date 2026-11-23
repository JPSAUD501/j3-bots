// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as ClientRuntime from "../src/client.ts";
import { Connection } from "../src/connection/Connection.ts";
import { Actions } from "../src/intents/Actions.ts";
import { waitFor } from "../src/Store.ts";
import {
  Browser,
  type BrowserView,
  type BrowserViewSize,
  type BrowserViewState,
  type BrowserViewStatus,
} from "../src/stores/Browser.ts";
import * as TestPlatform from "./platform.ts";

// A client's view of a bot's tab, against the real server's media socket over
// the in-memory engine's browser.

const server = Server.layer(Layer.empty);

const client = Layer.unwrap(
  Effect.map(Server.origin, (origin) =>
    Layer.fresh(ClientRuntime.layer.pipe(Layer.provideMerge(TestPlatform.layer(origin)))),
  ),
);

const jpeg = (byte: number) => new Uint8Array([0xff, 0xd8, byte, 0xff, 0xd9]);

const statusIs =
  (tag: BrowserViewStatus["_tag"]) =>
  (state: BrowserViewState): boolean =>
    state.status._tag === tag;

/** Each scene's tab is a tab of its own: the server is one for every test. */
let scenes = 0;

/** A paired client, and a bot with one tab open, which the client lists. */
const scene = Effect.gen(function* () {
  scenes += 1;
  const tab = `login-${scenes}`;
  const { code } = yield* (yield* Server.Devices).startPairing;
  const connection = yield* Connection;
  yield* connection.pair({ code, deviceName: "Phone" });
  yield* waitFor(connection.state, (state) => state._tag === "connected");
  const commandId = yield* (yield* Actions).commandId;
  const bot = yield* connection.call((rpc) => rpc["bot.create"]({ commandId, name: "Scout" }));
  yield* Server.botHasTabs(bot.id, [
    { id: tab, url: "https://www.example.com/login", title: "Sign in" },
  ]);
  const ref = yield* tabRef(bot.id);
  return { botId: bot.id, ref, tab };
});

const tabRef = (botId: BotId) =>
  Effect.gen(function* () {
    const tabs = yield* (yield* Browser).tabs(botId);
    const listed = yield* waitFor(
      tabs,
      (state) => state._tag === "ready" && state.value.some((tab) => tab.front),
    );
    if (listed._tag !== "ready") return yield* Effect.die("The tabs never loaded");
    const front = listed.value.find((tab) => tab.front);
    assert.strictEqual(front?.url, "https://www.example.com/login");
    return Option.getOrThrow(Option.fromNullishOr(front)).ref;
  });

/** A view of `ref`, the engine's `tab`, and the engine's viewer behind it. */
const watch = (
  { ref, tab }: { readonly ref: BrowserTabRef; readonly tab: string },
  size: BrowserViewSize = { maxWidth: 1080, quality: 55 },
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const engine = yield* Server.TestBrowserControl;
    const view = yield* browser.view({ ref, size: () => size });
    let viewer = yield* engine.nextViewer;
    // Viewers an earlier test left behind are of other tabs.
    while (viewer.tab !== tab) viewer = yield* engine.nextViewer;
    yield* waitFor(view.state, statusIs("live"));
    return { view, viewer };
  });

/** The next picture the view holds after `previous`. */
const pictureAfter = (view: BrowserView, previous: number) =>
  waitFor(view.picture, (picture) => picture !== null && picture.sequence > previous).pipe(
    Effect.map((picture) => Option.getOrThrow(Option.fromNullishOr(picture))),
  );

/** Waits until `check` holds of the engine's viewer, polling: it has no events of its own. */
const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("5 millis") }));

it.layer(server, { excludeTestServices: true })("the bot's browser", (it) => {
  it.effect("asks for the size the screen draws, and the next picture only once one is drawn", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { view, viewer } = yield* watch(opened);
      assert.deepStrictEqual(viewer.size, { maxWidth: 1080, maxHeight: 800, quality: 55 });

      yield* viewer.emit({ _tag: "viewport", width: 1280, height: 800 });
      yield* viewer.emit({ _tag: "frame", jpeg: jpeg(1) });
      yield* viewer.emit({ _tag: "frame", jpeg: jpeg(2) });
      const first = yield* pictureAfter(view, 0);
      assert.deepStrictEqual([...first.jpeg], [...jpeg(1)]);
      assert.deepStrictEqual(view.state.get().viewport, { width: 1280, height: 800 });
      // The second waits behind the first until the screen has drawn it.
      assert.strictEqual(view.picture.get()?.sequence, first.sequence);
      assert.strictEqual(yield* viewer.acks, 0);

      yield* view.ack(first.sequence);
      const second = yield* pictureAfter(view, first.sequence);
      assert.deepStrictEqual([...second.jpeg], [...jpeg(2)]);
      yield* eventually(Effect.map(viewer.acks, (acks) => acks === 1));
      // An acknowledgement twice over is one.
      yield* view.ack(first.sequence);
      yield* view.ack(second.sequence);
      yield* view.ack(second.sequence);
      yield* eventually(Effect.map(viewer.acks, (acks) => acks === 2));
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("asks a screen taller than the largest picture for the largest", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { viewer } = yield* watch(opened, { maxWidth: 1080, maxHeight: 2400, quality: 55 });
      assert.deepStrictEqual(viewer.size, { maxWidth: 1080, maxHeight: 2160, quality: 55 });
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("keeps the tab through a dropped socket, and opens it again on its own", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const network = yield* TestPlatform.TestNetwork;
      const { view, viewer } = yield* watch(opened);
      yield* view.send({ type: "take" });
      yield* eventually(Effect.map(viewer.inputs, (inputs) => inputs.length === 1));
      yield* viewer.emit({
        _tag: "control",
        controller: "this-viewer",
        generation: 1,
        dialog: null,
      });
      yield* waitFor(view.state, (state) => state.control?.controller === "you");

      yield* network.dropSockets;
      // What the page looked like and who holds it stay while the view reconnects.
      const dropped = yield* waitFor(view.state, statusIs("reconnecting"));
      assert.strictEqual(dropped.control?.controller, "you");
      yield* waitFor(view.state, statusIs("live"));
      // The server kept the engine's viewer for this device: no other opened, nothing given back.
      assert.isFalse(yield* viewer.isReleased);
      assert.deepStrictEqual(yield* viewer.inputs, [{ type: "take" }]);
      yield* view.send({ type: "text", text: "operator@example.com" });
      yield* eventually(Effect.map(viewer.inputs, (inputs) => inputs.length === 2));
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("gives the tab back only when asked, even sent while the socket was down", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const lifecycle = yield* TestPlatform.TestLifecycle;
      const { view, viewer } = yield* watch(opened);
      yield* view.send({ type: "take" });
      yield* viewer.emit({
        _tag: "control",
        controller: "this-viewer",
        generation: 1,
        dialog: null,
      });
      yield* waitFor(view.state, (state) => state.control?.controller === "you");

      yield* lifecycle.set("background");
      yield* waitFor(view.state, statusIs("paused"));
      // Typing is about a page the operator no longer sees; giving the tab back is not.
      yield* view.send({ type: "text", text: "lost" });
      yield* view.send({ type: "release" });
      yield* lifecycle.set("foreground");
      yield* waitFor(view.state, statusIs("live"));
      yield* eventually(Effect.map(viewer.inputs, (inputs) => inputs.length === 2));
      assert.deepStrictEqual(yield* viewer.inputs, [{ type: "take" }, { type: "release" }]);
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("gives way to a second view of the tab on this device", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { view: first } = yield* watch(opened);
      const second = yield* (yield* Browser).view({ ref: opened.ref, size: () => ({}) });
      yield* waitFor(second.state, statusIs("live"));
      yield* waitFor(first.state, statusIs("replaced"));
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("stops for good when the tab closes", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { view, viewer } = yield* watch(opened);
      yield* viewer.close(new Server.ViewerClosed({ reason: "gone" }));
      yield* waitFor(view.state, statusIs("gone"));
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("opens from an app's client, whose platform answers asynchronously", () =>
    Effect.gen(function* () {
      scenes += 1;
      const tab = `login-${scenes}`;
      const origin = yield* Server.origin;
      const { code } = yield* (yield* Server.Devices).startPairing;
      const app = yield* Effect.acquireRelease(
        Effect.promise(() => ClientRuntime.createJ3Client(TestPlatform.layer(origin))),
        (app) => Effect.promise(() => app.dispose()),
      );
      const paired = yield* Effect.promise(() => app.pair({ code, deviceName: "Phone" }));
      assert.strictEqual(paired._tag, "paired");
      const commandId = yield* Effect.promise(() => app.commandId());
      const created = yield* Effect.promise(() =>
        app.call((rpc) => rpc["bot.create"]({ commandId, name: "Scout" })),
      );
      if (created._tag !== "Success") return yield* Effect.die("The bot was not created");
      yield* Server.botHasTabs(created.value.id, [
        { id: tab, url: "https://www.example.com/login", title: "Sign in" },
      ]);
      const tabs = app.openBrowserTabs(created.value.id);
      const listed = yield* waitFor(
        tabs.state,
        (state) => state._tag === "ready" && state.value.some((each) => each.front),
      );
      const front = listed._tag === "ready" ? listed.value.find((each) => each.front) : undefined;
      if (front === undefined) return yield* Effect.die("The tab was not listed");

      const view = app.openBrowserView({ ref: front.ref, size: () => ({}) });
      yield* waitFor(view.state, statusIs("live"));
      view.close();
      tabs.release();
    }).pipe(Effect.scoped),
  );

  it.effect("says what the host lacks when the browser cannot start", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { view, viewer } = yield* watch(opened);
      yield* viewer.close(new Server.ViewerClosed({ reason: "setup-needed", need: "libraries" }));
      const ended = yield* waitFor(view.state, statusIs("setup-needed"));
      assert.deepStrictEqual(ended.status, { _tag: "setup-needed", need: "libraries" });
    }).pipe(Effect.scoped, Effect.provide(client)),
  );
});
