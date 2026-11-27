// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, BrowserTabRef, SharedBrowserTab } from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
// the server's own browser, which a fake page host stands in for.

const server = Server.layer(Layer.empty);

const client = Layer.unwrap(
  Effect.map(Server.origin, (origin) =>
    Layer.fresh(ClientRuntime.layer.pipe(Layer.provideMerge(TestPlatform.layer(origin)))),
  ),
);

const LOGIN = "https://www.example.com/login";

const statusIs =
  (tag: BrowserViewStatus["_tag"]) =>
  (state: BrowserViewState): boolean =>
    state.status._tag === tag;

/** Waits until `check` holds, polling: the fake host has no events of its own. */
const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("5 millis") }));

/** The host's calls of `call` on `ref`: the host is one for every test. */
const callsOn = (host: Server.FakePageHost, call: string, ref: BrowserTabRef) =>
  Effect.map(host.calls, (calls) => calls.filter((each) => each.call === call && each.tab === ref));

/** The tab as the server shares it, once it is listed. */
const shared = (ref: BrowserTabRef) =>
  Effect.gen(function* () {
    const browser = yield* Server.Browser;
    const found = yield* browser.all.pipe(
      Stream.map(({ tabs }) => tabs.find((tab) => tab.ref === ref)),
      Stream.filter((tab): tab is SharedBrowserTab => tab !== undefined),
      Stream.runHead,
    );
    return Option.getOrThrow(found);
  });

/** A paired client, and a bot with a tab open in the server's browser, which the client lists. */
const scene = Effect.gen(function* () {
  const { code } = yield* (yield* Server.Devices).startPairing;
  const connection = yield* Connection;
  yield* connection.pair({ code, deviceName: "Phone" });
  yield* waitFor(connection.state, (state) => state._tag === "connected");
  const commandId = yield* (yield* Actions).commandId;
  const bot = yield* connection.call((rpc) => rpc["bot.create"]({ commandId, name: "Scout" }));
  const opened = yield* Server.botOpens(bot.id, LOGIN);
  const ref = yield* tabRef(bot.id);
  assert.strictEqual(ref, opened);
  const host = yield* (yield* Server.TestServerBrowser).running;
  return { botId: bot.id, ref, host };
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
    assert.strictEqual(front?.url, LOGIN);
    return Option.getOrThrow(Option.fromNullishOr(front)).ref;
  });

/** A view of `ref`, live, and the size the server asked the host's screencast for. */
const watch = (
  { ref, host }: { readonly ref: BrowserTabRef; readonly host: Server.FakePageHost },
  size: BrowserViewSize = { maxWidth: 1080, quality: 55 },
) =>
  Effect.gen(function* () {
    const view = yield* (yield* Browser).view({ ref, size: () => size });
    yield* eventually(
      Effect.map(callsOn(host, "tab.screencast", ref), (calls) => calls.length > 0),
    );
    const [screencast] = yield* callsOn(host, "tab.screencast", ref);
    yield* waitFor(view.state, statusIs("live"));
    return { view, asked: screencast?.size };
  });

/** The next picture the view holds after `previous`. */
const pictureAfter = (view: BrowserView, previous: number) =>
  waitFor(view.picture, (picture) => picture !== null && picture.sequence > previous).pipe(
    Effect.map((picture) => Option.getOrThrow(Option.fromNullishOr(picture))),
  );

/** How many of the tab's pictures the host has heard were drawn. */
const ackedOn = (host: Server.FakePageHost, ref: BrowserTabRef) =>
  Effect.map(host.acked, (acked) => acked.filter((each) => each.tab === ref).length);

it.layer(server, { excludeTestServices: true })("the bot's browser", (it) => {
  it.effect("asks for the size the screen draws, and the next picture only once one is drawn", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { host, ref } = opened;
      const { view, asked } = yield* watch(opened);
      assert.deepStrictEqual(asked, { maxWidth: 1080, maxHeight: 800, quality: 55 });

      yield* host.paint(ref);
      yield* host.paint(ref);
      const first = yield* pictureAfter(view, 0);
      assert.deepStrictEqual(view.state.get().viewport, { width: 1280, height: 800 });
      // The second waits behind the first until the screen has drawn it.
      assert.strictEqual(view.picture.get()?.sequence, first.sequence);
      assert.strictEqual(yield* ackedOn(host, ref), 0);

      yield* view.ack(first.sequence);
      const second = yield* pictureAfter(view, first.sequence);
      assert.strictEqual(yield* ackedOn(host, ref), 1);
      // An acknowledgement twice over is one.
      yield* view.ack(first.sequence);
      yield* view.ack(second.sequence);
      yield* view.ack(second.sequence);
      yield* eventually(Effect.map(ackedOn(host, ref), (acked) => acked === 2));
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("asks a screen taller than the largest picture for the largest", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { asked } = yield* watch(opened, { maxWidth: 1080, maxHeight: 2400, quality: 55 });
      assert.deepStrictEqual(asked, { maxWidth: 1080, maxHeight: 2160, quality: 55 });
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("keeps the tab through a dropped socket, and opens it again on its own", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { host, ref } = opened;
      const network = yield* TestPlatform.TestNetwork;
      const { view } = yield* watch(opened);
      yield* view.send({ type: "take" });
      yield* waitFor(view.state, (state) => state.control?.controller === "you");

      yield* network.dropSockets;
      // What the page looked like and who holds it stay while the view reconnects.
      const dropped = yield* waitFor(view.state, statusIs("reconnecting"));
      assert.strictEqual(dropped.control?.controller, "you");
      yield* waitFor(view.state, statusIs("live"));
      // The person still holds the tab until they give it back: a dropped socket gives nothing back.
      const tab = yield* shared(ref);
      assert.isTrue(tab.heldBy?.kind === "person" && tab.heldBy.until === null);
      yield* view.send({ type: "text", text: "operator@example.com" });
      yield* eventually(
        Effect.map(callsOn(host, "tab.input", ref), (inputs) => inputs.length === 1),
      );
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("gives the tab back only when asked, even sent while the socket was down", () =>
    Effect.gen(function* () {
      const opened = yield* scene;
      const { host, ref } = opened;
      const lifecycle = yield* TestPlatform.TestLifecycle;
      const { view } = yield* watch(opened);
      yield* view.send({ type: "take" });
      yield* waitFor(view.state, (state) => state.control?.controller === "you");

      yield* lifecycle.set("background");
      yield* waitFor(view.state, statusIs("paused"));
      // Typing is about a page the operator no longer sees; giving the tab back is not.
      yield* view.send({ type: "text", text: "lost" });
      yield* view.send({ type: "release" });
      yield* lifecycle.set("foreground");
      yield* waitFor(view.state, statusIs("live"));
      yield* waitFor(view.state, (state) => state.control?.controller !== "you");
      assert.notStrictEqual((yield* shared(ref)).heldBy?.kind, "person");
      assert.deepStrictEqual(yield* callsOn(host, "tab.input", ref), []);
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
      const { view } = yield* watch(opened);
      yield* (yield* Server.Browser).close(opened.ref).pipe(Effect.orDie);
      yield* waitFor(view.state, statusIs("gone"));
    }).pipe(Effect.scoped, Effect.provide(client)),
  );

  it.effect("opens from an app's client, whose platform answers asynchronously", () =>
    Effect.gen(function* () {
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
      yield* Server.botOpens(created.value.id, LOGIN);
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
});
