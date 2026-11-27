// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { TelemetryEvent } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import { recorded } from "../testing/telemetry.ts";
import { command, createBot, finishRunning, sendToBot, turnEnded } from "../testing/turns.ts";
import { TelemetrySwitch } from "./TelemetrySwitch.ts";

type Named<Name extends TelemetryEvent["event"]> = Extract<
  TelemetryEvent,
  { readonly event: Name }
>;

/** The properties of each event named `name` the domain recorded, in order. */
const propertiesOf = <Name extends TelemetryEvent["event"]>(name: Name) =>
  recorded.pipe(
    Effect.map((all) =>
      all
        .map((each) => each.event)
        .filter((event): event is Named<Name> => event.event === name)
        .map((event) => event.properties),
    ),
  );

it.effect(
  "records a bot made, the operator's message and the turn it woke, once each is kept",
  () =>
    Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      assert.deepStrictEqual(yield* propertiesOf("bot.created"), [
        { harness: "claude-code", fromTemplate: false, by: "operator" },
      ]);

      yield* sendToBot(bot.id, "Hi");
      assert.deepStrictEqual(yield* propertiesOf("message.sent"), [
        { place: "conversation", mention: false, reply: false, quote: false, attachments: false },
      ]);

      yield* finishRunning(bot.id);
      yield* turnEnded(bot.id);
      const finished = yield* recorded.pipe(
        Effect.map((all) =>
          all.flatMap(({ event }) => (event.event === "turn.finished" ? [event.properties] : [])),
        ),
      );
      // The bot's first turn, which no one asked for, then the one the message woke.
      assert.deepStrictEqual(
        finished.map((each) => [each.origin, each.outcome, each.failure]),
        [
          ["other", "completed", null],
          ["conversation", "completed", null],
        ],
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("turns usage data off at once when the operator turns the switch off", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const onOff = yield* TelemetrySwitch;
    assert.deepStrictEqual((yield* settings.get).telemetry, { enabled: true, heldOff: false });

    const saved = yield* settings.update({ commandId: command(), changes: { telemetry: false } });
    assert.deepStrictEqual(saved.telemetry, { enabled: false, heldOff: false });
    assert.isFalse(yield* onOff.enabled);
  }).pipe(Effect.provide(TestDomain.layer)),
);
