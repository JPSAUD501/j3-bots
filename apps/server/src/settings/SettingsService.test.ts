// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CommandId, TimeZone } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestDomain from "../testing/domain.ts";
import { BasePrompt, layer as basePromptLayer } from "./BasePrompt.ts";
import { SettingsService, layer as settingsServiceLayer } from "./SettingsService.ts";
import { SettingsStore, layer as settingsStoreLayer } from "./SettingsStore.ts";

it.effect("changes only the notification switch a device sent", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    yield* settings.update({
      commandId: CommandId.make("previews-on"),
      changes: { notifications: { previews: true } },
    });
    // A device that still holds previews off turns notifications off.
    const saved = yield* settings.update({
      commandId: CommandId.make("off"),
      changes: { notifications: { enabled: false } },
    });

    assert.deepStrictEqual(saved.notifications, { enabled: false, previews: true });
    assert.deepStrictEqual((yield* settings.get).notifications, saved.notifications);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("answers a retry from a receipt written before notifications could be off", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const sql = yield* SqlClient.SqlClient;
    const save = settings.update({
      commandId: CommandId.make("previews-on"),
      changes: { notifications: { previews: true } },
    });
    yield* save;
    yield* sql`
      UPDATE command_receipts SET result_json = json_remove(result_json, '$.notifications.enabled')
      WHERE command_id = 'previews-on'
    `;

    assert.deepStrictEqual((yield* save).notifications, { enabled: true, previews: true });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("takes the time zone of the first device that gives one, and keeps it", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    assert.strictEqual((yield* settings.get).timeZone, "UTC");

    yield* settings.deviceTimeZone(TimeZone.make("America/Sao_Paulo"));
    yield* settings.deviceTimeZone(TimeZone.make("Europe/Lisbon"));

    assert.strictEqual((yield* settings.get).timeZone, "America/Sao_Paulo");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps the time zone the operator chose over any device's", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    // A save that only names the operator leaves the zone open to their device.
    yield* settings.update({ commandId: CommandId.make("name"), changes: { operatorName: "Ana" } });
    yield* settings.update({
      commandId: CommandId.make("zone"),
      changes: { timeZone: TimeZone.make("UTC") },
    });

    yield* settings.deviceTimeZone(TimeZone.make("America/Sao_Paulo"));

    assert.strictEqual((yield* settings.get).timeZone, "UTC");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("passes over a device's zone the server does not know, and takes the next one", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;

    yield* settings.deviceTimeZone(TimeZone.make("Mars/Olympus_Mons"));
    assert.strictEqual((yield* settings.get).timeZone, "UTC");
    yield* settings.deviceTimeZone(TimeZone.make("Asia/Tokyo"));

    assert.strictEqual((yield* settings.get).timeZone, "Asia/Tokyo");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("passes over a device on UTC's clock, so the operator's real device sets the zone", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;

    yield* settings.deviceTimeZone(TimeZone.make("Etc/UTC"));
    yield* settings.deviceTimeZone(TimeZone.make("America/Sao_Paulo"));

    assert.strictEqual((yield* settings.get).timeZone, "America/Sao_Paulo");
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** A read of the settings held after it read the row, until it is released. */
interface Hold {
  readonly read: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

/**
 * The settings store, but the next `get` after a hold is set reads the row,
 * then waits for the release before it returns what it read: a read that
 * loses the race to a later write, every time.
 */
const holdingStore = (held: Ref.Ref<Option.Option<Hold>>) =>
  Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const store = yield* SettingsStore;
      return SettingsStore.of({
        ...store,
        get: Effect.gen(function* () {
          const settings = yield* store.get;
          const hold = yield* Ref.getAndSet(held, Option.none());
          if (Option.isSome(hold)) {
            yield* Deferred.succeed(hold.value.read, undefined);
            yield* Deferred.await(hold.value.release);
          }
          return settings;
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.fresh(settingsStoreLayer)));

/**
 * Runs `first` until its read of the settings is held, then `second` (which
 * writes and reads again), then lets `first` finish.
 */
const firstReadsBeforeSecond = <A, B>(
  held: Ref.Ref<Option.Option<Hold>>,
  first: Effect.Effect<A>,
  second: Effect.Effect<B>,
) =>
  Effect.gen(function* () {
    const hold: Hold = {
      read: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    yield* Ref.set(held, Option.some(hold));
    const late = yield* Effect.forkChild(first, { startImmediately: true });
    yield* Deferred.await(hold.read);
    const early = yield* Effect.forkChild(second, { startImmediately: true });
    yield* Effect.yieldNow;
    yield* Deferred.succeed(hold.release, undefined);
    yield* Fiber.join(late);
    yield* Fiber.join(early);
  });

it.effect("leaves every device on the later of two names saved close together", () =>
  Effect.gen(function* () {
    const held = yield* Ref.make(Option.none<Hold>());
    yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.save({ operatorName: "Ana" });

      // The publish for Ana reads her name, and Bia's is saved and published
      // before it sets what it read.
      yield* firstReadsBeforeSecond(
        held,
        settings.applied({}),
        Effect.andThen(settings.save({ operatorName: "Bia" }), settings.applied({})).pipe(
          Effect.orDie,
        ),
      );

      const followed = Option.getOrThrow(yield* Stream.runHead(settings.changes));
      assert.strictEqual(followed.operatorName, "Bia");
    }).pipe(
      Effect.provide(Layer.fresh(settingsServiceLayer).pipe(Layer.provide(holdingStore(held)))),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves the base prompt on the later of two names saved close together", () =>
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const name = (operatorName: string) =>
      Effect.gen(function* () {
        const saved = yield* store.get;
        yield* store.save({ ...saved, operatorName }, yield* DateTime.now, { zoneChosen: false });
      });
    const held = yield* Ref.make(Option.none<Hold>());
    yield* Effect.gen(function* () {
      const basePrompt = yield* BasePrompt;
      yield* name("Ana");

      yield* firstReadsBeforeSecond(
        held,
        basePrompt.refresh,
        Effect.andThen(name("Bia"), basePrompt.refresh),
      );

      const prompt = Option.getOrThrow(yield* Stream.runHead(basePrompt.text));
      assert.include(prompt, "You are one of Bia's bots in J3 Bots.");
    }).pipe(Effect.provide(Layer.fresh(basePromptLayer).pipe(Layer.provide(holdingStore(held)))));
  }).pipe(Effect.provide(TestDomain.layer)),
);
