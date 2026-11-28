// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type FakePageHost, makeFakePageHost } from "@j3-bots/browser/testing";
import {
  type BrowserClientFrame,
  type BrowserController,
  type BrowserServerFrame,
  BrowserTabRef,
  type DeviceId,
} from "@j3-bots/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { Devices } from "../devices/Devices.ts";
import { botOpens } from "../testing/browser.ts";
import * as TestDomain from "../testing/domain.ts";
import { createNewBot } from "../testing/turns.ts";
import { Browser, DESKTOP_GRACE } from "./Browser.ts";
import {
  BrowserViewers,
  type ClientLink,
  DEFAULT_VIEW_SIZE,
  LinkClosed,
  SILENT_LIMIT,
} from "./BrowserViewers.ts";
import { TabAccess } from "./TabAccess.ts";
import { PERSON_HOLD } from "./TabControl.ts";

type Received = Uint8Array | BrowserServerFrame;

/** Lets the fibers the test started run until they wait. */
const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

/** A client's media socket, without the socket: what it was sent, and what it says. */
const fakeLink = Effect.gen(function* () {
  const received = yield* Queue.unbounded<Received>();
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
  /** The next message that `keep` is true of, passing over the others. */
  const nextWhere = <A extends Received>(keep: (message: Received) => message is A) =>
    Effect.gen(function* () {
      while (true) {
        const message = yield* Queue.take(received);
        if (keep(message)) return message;
      }
    });
  return {
    link,
    next: Queue.take(received),
    nextWhere,
    /** Every message sent so far and not taken yet. */
    pending: settle.pipe(Effect.andThen(Queue.clear(received))),
    say: (frame: BrowserClientFrame) => Queue.offer(incoming, frame).pipe(Effect.asVoid),
    closed: Deferred.await(closed),
  };
});

const isPicture = (message: Received): message is Uint8Array => message instanceof Uint8Array;
const isControl = (
  message: Received,
): message is Extract<BrowserServerFrame, { readonly type: "control" }> =>
  !(message instanceof Uint8Array) && message.type === "control";
const isGone = (
  message: Received,
): message is Extract<BrowserServerFrame, { readonly type: "gone" }> =>
  !(message instanceof Uint8Array) && message.type === "gone";
const isPing = (
  message: Received,
): message is Extract<BrowserServerFrame, { readonly type: "ping" }> =>
  !(message instanceof Uint8Array) && message.type === "ping";
const isRefused = (
  message: Received,
): message is Extract<BrowserServerFrame, { readonly type: "refused" }> =>
  !(message instanceof Uint8Array) && message.type === "refused";
const isProbe = (
  message: Received,
): message is Extract<BrowserServerFrame, { readonly type: "probe" }> =>
  !(message instanceof Uint8Array) && message.type === "probe";

/** Waits until `check` holds, letting other fibers run meanwhile. */
const eventually = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 1000; round++) {
      if (yield* check) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("The condition never held");
  });

let pairings = 0;
const pairDevice = (name: string) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const { code } = yield* devices.startPairing;
    return (yield* devices.pair({ code, name: `${name} ${++pairings}` })).deviceId;
  });

let tabs = 0;

/**
 * A laptop whose app's browser is attached, a phone, and a tab the person
 * opened on the laptop, which no bot is on.
 */
const scene = Effect.gen(function* () {
  const laptop = yield* pairDevice("Laptop");
  const phone = yield* pairDevice("Phone");
  const browser = yield* Browser;
  const host = yield* makeFakePageHost({ host: { kind: "desktop", device: laptop } });
  yield* browser.attachHost(host, yield* host.hello.pipe(Effect.orDie));
  const ref = BrowserTabRef.make(`tab-${++tabs}`);
  yield* browser.openForPerson({ device: laptop, ref, url: "https://example.com/" });
  return { browser, host, laptop, phone, ref };
});

/** Connects `link` as `deviceId` to the tab: the socket's fiber. */
const connect = (deviceId: DeviceId, ref: BrowserTabRef, link: ClientLink) =>
  Effect.gen(function* () {
    const viewers = yield* BrowserViewers;
    return yield* viewers
      .connect({ deviceId, ref, size: DEFAULT_VIEW_SIZE, link })
      .pipe(Effect.forkScoped);
  });

const callsOf = (host: FakePageHost, call: string) =>
  Effect.map(host.calls, (calls) => calls.filter((each) => each.call === call).length);

/** The frames of the host's screencast acknowledged so far. */
const ackedFrames = (host: FakePageHost) =>
  Effect.map(host.acked, (acked) => acked.map((each) => each.frame));

/** Waits for a control frame saying `controller`. */
const controlSays = (client: Effect.Success<typeof fakeLink>, controller: BrowserController) =>
  Effect.gen(function* () {
    while (true) {
      const frame = yield* client.nextWhere(isControl);
      if (frame.controller === controller) return frame;
    }
  });

const textInput = { type: "text", text: "hello" } as const;
const pointerMove = {
  type: "pointer",
  action: "move",
  x: 10,
  y: 10,
  button: "none",
  buttons: 0,
  clickCount: 0,
  modifiers: 0,
} as const;

it.effect(
  "shares one screencast between two devices, paced by the fastest, and gives a slow socket only the newest picture",
  () =>
    Effect.gen(function* () {
      const { host, laptop, phone, ref } = yield* scene;
      const fast = yield* fakeLink;
      const slow = yield* fakeLink;
      yield* connect(laptop, ref, fast.link);
      yield* connect(phone, ref, slow.link);
      yield* eventually(Effect.map(callsOf(host, "tab.screencast"), (n) => n === 1));

      yield* host.paint(ref);
      yield* fast.nextWhere(isPicture);
      yield* slow.nextWhere(isPicture);
      yield* fast.say({ type: "ack" });
      yield* eventually(Effect.map(ackedFrames(host), (frames) => frames.length === 1));

      // Two more while the slow socket still draws the first.
      yield* host.paint(ref);
      yield* fast.nextWhere(isPicture);
      yield* host.paint(ref);
      yield* fast.say({ type: "ack" });
      yield* fast.nextWhere(isPicture);
      assert.deepStrictEqual(yield* ackedFrames(host), [1, 2]);

      // The slow socket drew its first: it gets the newest, and none in between.
      yield* slow.say({ type: "ack" });
      yield* slow.nextWhere(isPicture);
      assert.isFalse((yield* slow.pending).some(isPicture));
      assert.deepStrictEqual(yield* ackedFrames(host), [1, 2]);

      // Whichever socket draws the newest first lets the host send the next.
      yield* slow.say({ type: "ack" });
      yield* eventually(Effect.map(ackedFrames(host), (frames) => frames.length === 3));
      assert.deepStrictEqual(yield* ackedFrames(host), [1, 2, 3]);
      assert.strictEqual(yield* callsOf(host, "tab.screencast"), 1);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("gives a socket that joins the page's size, who acts on it, and its latest picture", () =>
  Effect.gen(function* () {
    const { host, laptop, phone, ref } = yield* scene;
    const first = yield* fakeLink;
    yield* connect(laptop, ref, first.link);
    yield* eventually(Effect.map(callsOf(host, "tab.screencast"), (n) => n === 1));
    yield* host.paint(ref);
    yield* first.nextWhere(isPicture);

    const joining = yield* fakeLink;
    yield* connect(phone, ref, joining.link);
    assert.deepStrictEqual(yield* joining.next, { type: "viewport", width: 1280, height: 800 });
    const control = yield* joining.next;
    assert.isTrue(isControl(control) && control.controller === "nobody");
    assert.isTrue(isPicture(yield* joining.next));
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("closes a device's socket on a tab once its next one there opens", () =>
  Effect.gen(function* () {
    const { host, laptop, ref } = yield* scene;
    const older = yield* fakeLink;
    const olderSocket = yield* connect(laptop, ref, older.link);
    yield* eventually(Effect.map(callsOf(host, "tab.screencast"), (n) => n === 1));

    const newer = yield* fakeLink;
    yield* connect(laptop, ref, newer.link);
    assert.deepStrictEqual(yield* older.closed, { code: 4409, reason: "replaced" });
    yield* Fiber.join(olderSocket);

    yield* host.paint(ref);
    yield* newer.nextWhere(isPicture);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "tells each socket who acts on the tab: the person on it, on another device, a bot, or nobody",
  () =>
    Effect.gen(function* () {
      const { laptop, phone, ref } = yield* scene;
      const onLaptop = yield* fakeLink;
      const onPhone = yield* fakeLink;
      yield* connect(laptop, ref, onLaptop.link);
      yield* connect(phone, ref, onPhone.link);
      yield* controlSays(onLaptop, "nobody");
      yield* controlSays(onPhone, "nobody");

      yield* onLaptop.say({ type: "take" });
      const taken = yield* controlSays(onLaptop, "you");
      yield* controlSays(onPhone, "another-device");
      // The other device cannot take it meanwhile.
      yield* onPhone.say({ type: "take" });
      yield* onLaptop.say({ type: "release" });
      const released = yield* controlSays(onLaptop, "nobody");
      yield* controlSays(onPhone, "nobody");
      assert.isAbove(released.generation, taken.generation);

      // Let go once idle: the hold lapses after the person's hold time.
      yield* onPhone.say(textInput);
      yield* controlSays(onPhone, "you");
      yield* onPhone.say({ type: "release", idle: true });
      yield* settle;
      yield* TestClock.adjust(PERSON_HOLD);
      yield* controlSays(onPhone, "nobody");

      const bot = yield* createNewBot("Scout");
      const botTab = yield* botOpens(bot.id, "https://example.com/news");
      const onBotTab = yield* fakeLink;
      yield* connect(laptop, botTab, onBotTab.link);
      yield* controlSays(onBotTab, "bot");
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "drops a device's page input while a person on another device holds the tab, and passes on the holder's",
  () =>
    Effect.gen(function* () {
      const { host, laptop, phone, ref } = yield* scene;
      const onLaptop = yield* fakeLink;
      const onPhone = yield* fakeLink;
      yield* connect(laptop, ref, onLaptop.link);
      yield* connect(phone, ref, onPhone.link);
      yield* onPhone.say({ type: "take" });
      yield* controlSays(onPhone, "you");

      yield* onLaptop.say(textInput);
      yield* onLaptop.say(pointerMove);
      yield* onLaptop.say({ type: "reload" });
      // A probe is answered after what came before it on the socket.
      yield* onLaptop.say({ type: "probe", x: 5, y: 6 });
      assert.deepStrictEqual(yield* onLaptop.nextWhere(isProbe), {
        type: "probe",
        x: 5,
        y: 6,
        editable: false,
      });
      assert.strictEqual(yield* callsOf(host, "tab.input"), 0);
      assert.strictEqual(yield* callsOf(host, "tab.navigate"), 0);

      yield* onPhone.say(pointerMove);
      yield* onPhone.say(textInput);
      yield* eventually(Effect.map(callsOf(host, "tab.input"), (n) => n === 2));
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("says a tab is gone once it closes, and of a tab it does not know", () =>
  Effect.gen(function* () {
    const { browser, laptop, ref } = yield* scene;
    const client = yield* fakeLink;
    const socket = yield* connect(laptop, ref, client.link);
    yield* controlSays(client, "nobody");

    yield* browser.close(ref);
    assert.deepStrictEqual(yield* client.nextWhere(isGone), {
      type: "gone",
    });
    assert.strictEqual((yield* client.closed).code, 1000);
    yield* Fiber.join(socket);

    const unknown = yield* fakeLink;
    yield* connect(laptop, BrowserTabRef.make("no-such-tab"), unknown.link);
    assert.deepStrictEqual(yield* unknown.next, { type: "gone" });
    assert.strictEqual((yield* unknown.closed).code, 1000);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("closes a revoked device's socket as invalid", () =>
  Effect.gen(function* () {
    const { phone, ref } = yield* scene;
    const client = yield* fakeLink;
    const socket = yield* connect(phone, ref, client.link);
    yield* controlSays(client, "nobody");

    yield* (yield* DeviceAuth).revoke(phone);
    assert.strictEqual((yield* client.closed).code, 1008);
    yield* Fiber.join(socket);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("pings a socket, keeps one that answers, and ends one silent for the limit", () =>
  Effect.gen(function* () {
    const { laptop, phone, ref } = yield* scene;
    const answering = yield* fakeLink;
    const silent = yield* fakeLink;
    const kept = yield* connect(laptop, ref, answering.link);
    const ended = yield* connect(phone, ref, silent.link);
    yield* settle;

    const ping = Duration.toMillis(SILENT_LIMIT) / 3;
    for (let round = 0; round < 3; round++) {
      yield* TestClock.adjust(ping);
      yield* answering.nextWhere(isPing);
      yield* answering.say({ type: "pong" });
      yield* settle;
    }
    yield* Fiber.join(ended);
    assert.isUndefined(kept.pollUnsafe());
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses a person's input while the tab's app is away, holding nothing, and says the tab is parked once the grace ends",
  () =>
    Effect.gen(function* () {
      const laptop = yield* pairDevice("Laptop");
      const phone = yield* pairDevice("Phone");
      const browser = yield* Browser;
      const host = yield* makeFakePageHost({ host: { kind: "desktop", device: laptop } });
      const attached = yield* Scope.make();
      yield* browser
        .attachHost(host, yield* host.hello.pipe(Effect.orDie))
        .pipe(Scope.provide(attached));
      const ref = BrowserTabRef.make(`tab-${++tabs}`);
      yield* browser.openForPerson({ device: laptop, ref, url: "https://example.com/" });
      const client = yield* fakeLink;
      yield* connect(phone, ref, client.link);
      yield* controlSays(client, "nobody");

      yield* Scope.close(attached, Exit.void);
      yield* settle;
      yield* client.say(textInput);
      assert.deepStrictEqual(yield* client.nextWhere(isRefused), {
        type: "refused",
        reason: "away",
      });
      assert.strictEqual(yield* callsOf(host, "tab.input"), 0);
      const hands = Option.getOrThrow(yield* browser.handsOf(ref));
      assert.isNull((yield* hands.control.state).holder);

      // The grace passes on a socket that keeps answering its pings.
      const step = Duration.toMillis(DESKTOP_GRACE) / 3;
      for (let round = 0; round < 3; round++) {
        yield* TestClock.adjust(step);
        yield* client.say({ type: "pong" });
        yield* settle;
      }
      yield* client.say({ type: "reload" });
      assert.deepStrictEqual(yield* client.nextWhere(isRefused), {
        type: "refused",
        reason: "parked",
      });
      assert.strictEqual(yield* callsOf(host, "tab.navigate"), 0);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses input that waited behind a fill once the tab's app went away meanwhile, and keeps reading the socket",
  () =>
    Effect.gen(function* () {
      const laptop = yield* pairDevice("Laptop");
      const phone = yield* pairDevice("Phone");
      const browser = yield* Browser;
      const host = yield* makeFakePageHost({ host: { kind: "desktop", device: laptop } });
      const attached = yield* Scope.make();
      yield* browser
        .attachHost(host, yield* host.hello.pipe(Effect.orDie))
        .pipe(Scope.provide(attached));
      const ref = BrowserTabRef.make(`tab-${++tabs}`);
      yield* browser.openForPerson({ device: laptop, ref, url: "https://example.com/" });
      const client = yield* fakeLink;
      yield* connect(phone, ref, client.link);
      yield* controlSays(client, "nobody");

      // The server types a saved login: the person's input waits for it to end.
      const filling = yield* Scope.make();
      yield* (yield* TabAccess).holdForFill(ref).pipe(Effect.orDie, Scope.provide(filling));
      yield* client.say(textInput);
      yield* settle;
      yield* Scope.close(attached, Exit.void);
      yield* settle;
      yield* Scope.close(filling, Exit.void);

      assert.deepStrictEqual(yield* client.nextWhere(isRefused), {
        type: "refused",
        reason: "away",
      });
      yield* client.say(textInput);
      assert.deepStrictEqual(yield* client.nextWhere(isRefused), {
        type: "refused",
        reason: "away",
      });
      assert.strictEqual(yield* callsOf(host, "tab.input"), 0);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps the screencast going for those who stay when a socket leaves with a picture it never drew",
  () =>
    Effect.gen(function* () {
      const { host, laptop, phone, ref } = yield* scene;
      const staying = yield* fakeLink;
      yield* connect(laptop, ref, staying.link);
      yield* eventually(Effect.map(callsOf(host, "tab.screencast"), (n) => n === 1));

      // A still on the phone takes the newest picture with the laptop and leaves without drawing it.
      const still = yield* fakeLink;
      const stillSocket = yield* connect(phone, ref, still.link);
      yield* host.paint(ref);
      yield* staying.nextWhere(isPicture);
      yield* still.nextWhere(isPicture);
      yield* Fiber.interrupt(stillSocket);
      yield* staying.say({ type: "ack" });
      yield* eventually(Effect.map(ackedFrames(host), (frames) => frames.length === 1));
      yield* host.paint(ref);
      yield* staying.nextWhere(isPicture);

      // Again with the still leaving behind the newest picture, waiting for the one it draws.
      const second = yield* fakeLink;
      const secondSocket = yield* connect(phone, ref, second.link);
      yield* second.nextWhere(isPicture);
      yield* staying.say({ type: "ack" });
      yield* eventually(Effect.map(ackedFrames(host), (frames) => frames.length === 2));
      yield* host.paint(ref);
      yield* staying.nextWhere(isPicture);
      yield* settle;
      yield* Fiber.interrupt(secondSocket);
      yield* staying.say({ type: "ack" });
      yield* eventually(Effect.map(ackedFrames(host), (frames) => frames.length === 3));
      yield* host.paint(ref);
      yield* staying.nextWhere(isPicture);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives the host the picture it waits on when the last socket leaves still drawing an older one",
  () =>
    Effect.gen(function* () {
      const { host, laptop, phone, ref } = yield* scene;
      const fast = yield* fakeLink;
      const slow = yield* fakeLink;
      const fastSocket = yield* connect(laptop, ref, fast.link);
      const slowSocket = yield* connect(phone, ref, slow.link);
      yield* eventually(Effect.map(callsOf(host, "tab.screencast"), (n) => n === 1));
      yield* host.paint(ref);
      yield* fast.nextWhere(isPicture);
      yield* slow.nextWhere(isPicture);
      yield* fast.say({ type: "ack" });
      yield* eventually(Effect.map(ackedFrames(host), (frames) => frames.length === 1));
      // The host's second goes to the fast socket and waits for the slow one, which draws the first.
      yield* host.paint(ref);
      yield* fast.nextWhere(isPicture);
      yield* Fiber.interrupt(fastSocket);
      yield* Fiber.interrupt(slowSocket);
      yield* eventually(Effect.map(ackedFrames(host), (frames) => frames.length === 2));
      assert.deepStrictEqual(yield* ackedFrames(host), [1, 2]);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("asks the host again for a screencast that failed, while the feed lives", () =>
  Effect.gen(function* () {
    const { host, laptop, phone, ref } = yield* scene;
    yield* host.failNext("tab.screencast");
    const viewer = yield* fakeLink;
    yield* connect(laptop, ref, viewer.link);
    yield* settle;
    assert.strictEqual(yield* callsOf(host, "tab.screencast"), 0);

    yield* TestClock.adjust(Duration.seconds(1));
    yield* eventually(Effect.map(callsOf(host, "tab.screencast"), (n) => n === 1));
    yield* host.paint(ref);
    yield* viewer.nextWhere(isPicture);
    // A still that joins the feed has its picture at once.
    const still = yield* fakeLink;
    yield* connect(phone, ref, still.link);
    yield* still.nextWhere(isPicture);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);
