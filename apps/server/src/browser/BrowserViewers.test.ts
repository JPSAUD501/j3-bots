// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type {
  BotId,
  BrowserClientFrame,
  BrowserServerFrame,
  BrowserTab,
  BrowserTabRef,
  DeviceId,
} from "@j3-bots/contracts";
import {
  type EngineBrowserTab,
  EngineTabId,
  type SessionId,
  ViewerClosed,
} from "@j3-bots/engine-t3";
import { type FakeViewer, TestBrowserControl } from "@j3-bots/engine-t3/testing";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { Devices } from "../devices/Devices.ts";
import * as TestDomain from "../testing/domain.ts";
import { createNewBot, engineSession } from "../testing/turns.ts";
import { BrowserTabs } from "./BrowserTabs.ts";
import {
  BrowserViewers,
  type ClientLink,
  CONTROL_GRACE,
  DEFAULT_VIEW_SIZE,
  LinkClosed,
  SILENT_LIMIT,
} from "./BrowserViewers.ts";

/** A client's media socket, without the socket: what it was sent, and what it says. */
const fakeLink = Effect.gen(function* () {
  const received = yield* Queue.unbounded<Uint8Array | BrowserServerFrame>();
  const incoming = yield* Queue.unbounded<BrowserClientFrame, Cause.Done>();
  const closed = yield* Deferred.make<{ readonly code: number; readonly reason: string }>();
  const link: ClientLink = {
    send: (message) =>
      Deferred.isDone(closed).pipe(
        Effect.flatMap((done) =>
          done ? Effect.fail(new LinkClosed()) : Queue.offer(received, message).pipe(Effect.asVoid),
        ),
      ),
    close: (code, reason) =>
      Deferred.succeed(closed, { code, reason }).pipe(Effect.andThen(Queue.end(incoming))),
    incoming: Stream.fromQueue(incoming),
  };
  return {
    link,
    /** The next message the server sent. */
    next: Queue.take(received),
    say: (frame: BrowserClientFrame) => Queue.offer(incoming, frame).pipe(Effect.asVoid),
    /** The client closes its socket. */
    hangUp: Queue.end(incoming).pipe(Effect.asVoid),
    closed: Deferred.await(closed),
    isClosed: Deferred.isDone(closed),
  };
});

const pairDevice = (name: string) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const { code } = yield* devices.startPairing;
    return (yield* devices.pair({ code, name })).deviceId;
  });

const engineTab = (id: string, sessionId: SessionId, activeAt: number): EngineBrowserTab => ({
  id: EngineTabId.make(id),
  sessionId,
  url: `https://example.com/${id}`,
  title: id,
  loading: false,
  activeAt,
});

/** The bot's tabs as `deviceId` sees them, once there are `count`. */
const tabsSeen = (botId: BotId, deviceId: DeviceId, count: number) =>
  Effect.gen(function* () {
    const tabs = yield* BrowserTabs;
    const frame = yield* tabs.subscribe(botId, deviceId).pipe(
      Stream.filter((frame) => frame.tabs.length === count),
      Stream.runHead,
      Effect.orDie,
    );
    return Option.getOrThrow(frame).tabs;
  });

/** The bot's tabs as `deviceId` sees them, once `holds` is true of them. */
const tabsWhen = (
  botId: BotId,
  deviceId: DeviceId,
  holds: (tabs: ReadonlyArray<BrowserTab>) => boolean,
) =>
  Effect.gen(function* () {
    const tabs = yield* BrowserTabs;
    const frame = yield* tabs.subscribe(botId, deviceId).pipe(
      Stream.filter((frame) => holds(frame.tabs)),
      Stream.runHead,
      Effect.orDie,
    );
    return Option.getOrThrow(frame).tabs;
  });

/** A bot with the tabs `ids` open, the first the oldest, and a paired device. */
const scene = (...ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const bot = yield* createNewBot("Scout");
    const session = yield* engineSession(bot.id);
    const browser = yield* TestBrowserControl;
    yield* browser.setTabs(ids.map((id, index) => engineTab(id, session, index + 1)));
    const device = yield* pairDevice("Laptop");
    const listed = yield* tabsSeen(bot.id, device, ids.length);
    const refs = new Map(listed.map((tab) => [tab.title, tab.ref]));
    const refOf = (id: string): BrowserTabRef => {
      const ref = refs.get(id);
      if (ref === undefined) throw new Error(`No tab ${id}`);
      return ref;
    };
    return { bot, session, browser, device, refOf };
  });

/** Connects `link` as `deviceId` to the tab, and answers its socket's fiber and its viewer. */
const connect = (
  deviceId: DeviceId,
  ref: BrowserTabRef,
  link: ClientLink,
  viewer: Effect.Effect<FakeViewer> | null,
) =>
  Effect.gen(function* () {
    const viewers = yield* BrowserViewers;
    const socket = yield* viewers
      .connect({ deviceId, ref, size: DEFAULT_VIEW_SIZE, link })
      .pipe(Effect.forkScoped);
    return { socket, viewer: viewer === null ? null : yield* viewer };
  });

const picture = (byte: number) => new Uint8Array([0xff, 0xd8, byte, 0xff, 0xd9]);
const frame = (byte: number) => ({ _tag: "frame", jpeg: picture(byte) }) as const;
const viewport = { _tag: "viewport", width: 1280, height: 800 } as const;
const controlBy = (controller: "bot" | "this-viewer" | "another-viewer" | "nobody") =>
  ({ _tag: "control", controller, generation: 1, dialog: null }) as const;

it.effect(
  "asks the engine for a picture only after the client drew the last, and keeps only the newest",
  () =>
    Effect.gen(function* () {
      const { browser, device, refOf } = yield* scene("one");
      const client = yield* fakeLink;
      const { viewer } = yield* connect(device, refOf("one"), client.link, browser.nextViewer);
      if (viewer === null) return;

      yield* viewer.emit(frame(1));
      assert.deepStrictEqual(yield* client.next, picture(1));
      // Two more while the first is drawn: the second is dropped, and acknowledged unsent.
      yield* viewer.emit(frame(2));
      yield* viewer.emit(frame(3));
      yield* viewer.emit(viewport);
      assert.deepStrictEqual(yield* client.next, { type: "viewport", width: 1280, height: 800 });
      assert.strictEqual(yield* viewer.acks, 1);

      yield* client.say({ type: "ack" });
      assert.deepStrictEqual(yield* client.next, picture(3));
      assert.strictEqual(yield* viewer.acks, 2);
      yield* client.say({ type: "ack" });
      yield* client.say({ type: "take" });
      yield* viewer.emit(controlBy("this-viewer"));
      assert.deepStrictEqual(yield* client.next, {
        type: "control",
        controller: "you",
        generation: 1,
        dialog: null,
      });
      assert.strictEqual(yield* viewer.acks, 3);
      assert.deepStrictEqual(yield* viewer.inputs, [{ type: "take" }]);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("closes the engine's viewer once the client leaves a tab it does not hold", () =>
  Effect.gen(function* () {
    const { browser, device, refOf } = yield* scene("one");
    const client = yield* fakeLink;
    const { socket, viewer } = yield* connect(
      device,
      refOf("one"),
      client.link,
      browser.nextViewer,
    );
    if (viewer === null) return;

    yield* client.hangUp;
    yield* Fiber.join(socket);
    yield* viewer.released;
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("keeps a held tab for a minute after the socket drops, and gives it back after", () =>
  Effect.gen(function* () {
    const { bot, browser, device, refOf } = yield* scene("one");
    const other = yield* pairDevice("Desktop");
    const first = yield* fakeLink;
    const opened = yield* connect(device, refOf("one"), first.link, browser.nextViewer);
    const viewer = opened.viewer;
    if (viewer === null) return;
    yield* viewer.emit(frame(1));
    assert.deepStrictEqual(yield* first.next, picture(1));
    yield* first.say({ type: "ack" });
    yield* viewer.emit(controlBy("this-viewer"));
    yield* first.next;
    const held = yield* tabsWhen(bot.id, other, (tabs) => tabs[0]?.controller !== "bot");
    assert.strictEqual(held[0]?.controller, "another-device");

    // The connection drops: no ping is answered.
    yield* TestClock.adjust(SILENT_LIMIT);
    yield* Fiber.join(opened.socket);
    yield* TestClock.adjust("59 seconds");
    assert.isFalse(yield* viewer.isReleased);

    // Back within the minute: the same viewer, the tab still held, and the last picture.
    const second = yield* fakeLink;
    const back = yield* connect(device, refOf("one"), second.link, null);
    assert.deepStrictEqual(yield* second.next, {
      type: "control",
      controller: "you",
      generation: 1,
      dialog: null,
    });
    assert.deepStrictEqual(yield* second.next, picture(1));
    yield* second.say({ type: "ack" });
    assert.strictEqual(yield* viewer.acks, 1, "a picture sent again is not acknowledged again");

    yield* second.hangUp;
    yield* Fiber.join(back.socket);
    yield* TestClock.adjust(CONTROL_GRACE);
    yield* viewer.released;
    const free = yield* tabsWhen(bot.id, other, (tabs) => tabs[0]?.controller === "bot");
    assert.strictEqual(free.length, 1);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("hands a tab to the device's newest socket, and closes the one before", () =>
  Effect.gen(function* () {
    const { browser, device, refOf } = yield* scene("one");
    const first = yield* fakeLink;
    const { viewer } = yield* connect(device, refOf("one"), first.link, browser.nextViewer);
    if (viewer === null) return;
    yield* viewer.emit(viewport);
    yield* first.next;

    const second = yield* fakeLink;
    yield* connect(device, refOf("one"), second.link, null);
    assert.deepStrictEqual(yield* first.closed, { code: 4409, reason: "replaced" });
    assert.deepStrictEqual(yield* second.next, { type: "viewport", width: 1280, height: 800 });
    yield* first.say({ type: "take" });
    yield* second.say({ type: "reload" });
    yield* viewer.emit(viewport);
    yield* second.next;
    assert.deepStrictEqual(yield* viewer.inputs, [{ type: "reload" }]);
    assert.isFalse(yield* viewer.isReleased);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("closes every viewer of a revoked device at once, a held tab's included", () =>
  Effect.gen(function* () {
    const { browser, device, refOf } = yield* scene("one", "two");
    const watching = yield* fakeLink;
    const one = yield* connect(device, refOf("one"), watching.link, browser.nextViewer);
    const parked = yield* fakeLink;
    const two = yield* connect(device, refOf("two"), parked.link, browser.nextViewer);
    if (one.viewer === null || two.viewer === null) return;
    yield* two.viewer.emit(controlBy("this-viewer"));
    yield* parked.next;
    yield* parked.hangUp;
    yield* Fiber.join(two.socket);

    yield* (yield* DeviceAuth).revoke(device);

    assert.deepStrictEqual(yield* watching.closed, { code: 1008, reason: "revoked" });
    yield* one.viewer.released;
    yield* two.viewer.released;
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("tells the client a tab is gone, and why a viewer could not go on", () =>
  Effect.gen(function* () {
    const { browser, device, refOf } = yield* scene("one", "two");
    const client = yield* fakeLink;
    const { viewer } = yield* connect(device, refOf("one"), client.link, browser.nextViewer);
    if (viewer === null) return;
    yield* viewer.close(new ViewerClosed({ reason: "gone" }));
    assert.deepStrictEqual(yield* client.next, { type: "gone" });
    assert.deepStrictEqual(yield* client.closed, { code: 1000, reason: "gone" });

    const setup = yield* fakeLink;
    const two = yield* connect(device, refOf("two"), setup.link, browser.nextViewer);
    if (two.viewer === null) return;
    yield* two.viewer.close(new ViewerClosed({ reason: "setup-needed", need: "sandbox" }));
    assert.deepStrictEqual(yield* setup.next, { type: "setup-needed", need: "sandbox" });
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("lists a bot's tabs with who holds each, as each device sees them", () =>
  Effect.gen(function* () {
    const { bot, browser, device, refOf } = yield* scene("older", "newer");
    const other = yield* pairDevice("Desktop");
    const listed = yield* tabsSeen(bot.id, other, 2);
    assert.deepStrictEqual(
      listed.map((tab) => [tab.title, tab.front, tab.controller]),
      [
        ["older", false, "bot"],
        ["newer", true, "bot"],
      ],
    );

    const client = yield* fakeLink;
    const { viewer } = yield* connect(device, refOf("older"), client.link, browser.nextViewer);
    if (viewer === null) return;
    yield* viewer.emit(controlBy("this-viewer"));
    const mine = yield* tabsWhen(bot.id, device, (tabs) => tabs[0]?.controller === "you");
    const theirs = yield* tabsWhen(bot.id, other, (tabs) => tabs[0]?.controller !== "bot");
    assert.strictEqual(mine[0]?.controller, "you");
    assert.strictEqual(theirs[0]?.controller, "another-device");

    const someoneElse = yield* createNewBot("Quill");
    assert.deepStrictEqual(yield* tabsSeen(someoneElse.id, device, 0), []);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);
