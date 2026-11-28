// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { BotId, DeviceId } from "@j3-bots/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { BOT_LEASE, makeTabControl, PERSON_HOLD, QUEUE_WAIT } from "./TabControl.ts";

const ana = BotId.make("bot-ana");
const leo = BotId.make("bot-leo");
const phone = DeviceId.make("device-phone");
const laptop = DeviceId.make("device-laptop");

it.effect("runs one bot's action at a time, and lets another bot's wait for the lease", () =>
  Effect.gen(function* () {
    const control = yield* makeTabControl;
    const order: Array<string> = [];
    const gate = yield* Deferred.make<void>();
    const first = yield* control
      .act(ana, Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => order.push("ana")))))
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const second = yield* control
      .act(
        leo,
        Effect.sync(() => order.push("leo")),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepStrictEqual(order, []);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    // Ana keeps the lease a while after her action: Leo's runs once it lapses.
    yield* TestClock.adjust(BOT_LEASE);
    yield* Fiber.join(second);
    assert.deepStrictEqual(order, ["ana", "leo"]);
  }).pipe(Effect.scoped),
);

it.effect("lets the bot that holds the lease go on while another bot waits for the tab", () =>
  Effect.gen(function* () {
    const control = yield* makeTabControl;
    const order: Array<string> = [];
    yield* control.act(
      ana,
      Effect.sync(() => order.push("ana")),
    );
    const waiting = yield* control
      .act(
        leo,
        Effect.sync(() => order.push("leo")),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* control.act(
      ana,
      Effect.sync(() => order.push("ana again")),
    );
    yield* TestClock.adjust(BOT_LEASE);
    yield* Fiber.join(waiting);
    assert.deepStrictEqual(order, ["ana", "ana again", "leo"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "fails a bot's action that waited for all of the queue's wait, naming the bot that held the tab",
  () =>
    Effect.gen(function* () {
      const control = yield* makeTabControl;
      const holding = yield* control.act(ana, Effect.never).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const waiting = yield* control.act(leo, Effect.void).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(QUEUE_WAIT);
      const refused = yield* Fiber.join(waiting);
      assert.strictEqual(refused.reason, "bot");
      assert.strictEqual(refused.botId, ana);
      yield* Fiber.interrupt(holding);
    }).pipe(Effect.scoped),
);

it.effect(
  "gives the tab to a person at once, refuses bots while they hold it, and frees it once their input stops",
  () =>
    Effect.gen(function* () {
      const control = yield* makeTabControl;
      assert.isTrue(yield* control.personInput(phone));
      const refused = yield* control.act(ana, Effect.void).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "person");
      yield* TestClock.adjust(PERSON_HOLD);
      assert.isNull((yield* control.state).holder);
      yield* control.act(ana, Effect.void);
    }).pipe(Effect.scoped),
);

it.effect("keeps a person's wait for me until they give the tab back", () =>
  Effect.gen(function* () {
    const control = yield* makeTabControl;
    assert.isTrue(yield* control.waitForMe(phone));
    // Their input keeps the open hold.
    assert.isTrue(yield* control.personInput(phone));
    yield* TestClock.adjust(Duration.minutes(10));
    const refused = yield* control.act(ana, Effect.void).pipe(Effect.flip);
    assert.strictEqual(refused.reason, "waiting");
    yield* control.release(phone, false);
    yield* control.act(ana, Effect.void);
  }).pipe(Effect.scoped),
);

it.effect("hands back an idle release only once the person's hold lapses", () =>
  Effect.gen(function* () {
    const control = yield* makeTabControl;
    yield* control.waitForMe(phone);
    yield* control.release(phone, true);
    const holder = (yield* control.state).holder;
    assert.isTrue(holder?.kind === "person" && holder.until !== null);
    yield* TestClock.adjust(PERSON_HOLD);
    assert.isNull((yield* control.state).holder);
  }).pipe(Effect.scoped),
);

it.effect("leaves a person's hold to them while another device's input and wait are refused", () =>
  Effect.gen(function* () {
    const control = yield* makeTabControl;
    yield* control.waitForMe(phone);
    const epoch = (yield* control.state).epoch;
    assert.isFalse(yield* control.personInput(laptop));
    assert.isFalse(yield* control.waitForMe(laptop));
    // Another device's release gives nothing back.
    yield* control.release(laptop, false);
    const state = yield* control.state;
    assert.isTrue(state.holder?.kind === "person" && state.holder.device === phone);
    assert.strictEqual(state.epoch, epoch);
  }).pipe(Effect.scoped),
);

it.effect("fails a bot's queued action once a person takes the tab", () =>
  Effect.gen(function* () {
    const control = yield* makeTabControl;
    const holding = yield* control.act(ana, Effect.never).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const waiting = yield* control.act(leo, Effect.void).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* control.personInput(phone);
    const refused = yield* Fiber.join(waiting);
    assert.strictEqual(refused.reason, "person");
    yield* Fiber.interrupt(holding);
  }).pipe(Effect.scoped),
);

it.effect(
  "lets the server's fill go before a queued bot, and tells it when a person took the tab",
  () =>
    Effect.gen(function* () {
      const control = yield* makeTabControl;
      const gate = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const running = yield* control.act(ana, Deferred.await(gate)).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const queued = yield* control
        .act(
          leo,
          Effect.sync(() => order.push("leo")),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const filling = yield* control
        .fill((stillHeld) =>
          Effect.gen(function* () {
            order.push("fill");
            yield* control.personInput(phone);
            return yield* Effect.exit(stillHeld);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(running);
      const stillHeld = yield* Fiber.join(filling);
      assert.isTrue(Exit.isFailure(stillHeld));
      assert.deepStrictEqual(order, ["fill"]);
      // The person's input failed Leo's queued action.
      assert.isTrue(Exit.isFailure(yield* Fiber.await(queued)));
    }).pipe(Effect.scoped),
);

it.effect("fails a withdrawn bot's queued action and every action once the tab closes", () =>
  Effect.gen(function* () {
    const control = yield* makeTabControl;
    const holding = yield* control.act(ana, Effect.never).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const waiting = yield* control.act(leo, Effect.void).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* control.withdraw(leo);
    assert.strictEqual((yield* Fiber.join(waiting)).reason, "withdrawn");
    yield* Fiber.interrupt(holding);
    yield* control.close;
    assert.strictEqual((yield* control.act(ana, Effect.void).pipe(Effect.flip)).reason, "closed");
  }).pipe(Effect.scoped),
);

it.effect(
  "lets a person take the tab during a fill, and their input wait until its typing ends",
  () =>
    Effect.gen(function* () {
      const control = yield* makeTabControl;
      const typing = yield* Deferred.make<void>();
      const filling = yield* control.fill(() => Deferred.await(typing)).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isTrue(yield* control.personInput(phone));
      const input = yield* control.afterFill.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isUndefined(input.pollUnsafe());
      yield* Deferred.succeed(typing, undefined);
      yield* Fiber.join(filling);
      yield* Fiber.join(input);
      // With no fill, input goes at once.
      yield* control.afterFill;
    }).pipe(Effect.scoped),
);
