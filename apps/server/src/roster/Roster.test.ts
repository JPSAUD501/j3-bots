// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  CommandId,
  type RosterItem,
  type WorkStep,
  WorkStepId,
  type WorkTool,
} from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { Entries } from "../entries/Entries.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { Roster } from "./Roster.ts";

let commands = 0;
const command = () => CommandId.make(`command-${++commands}`);

const nameOf = (item: RosterItem) => (item._tag === "bot" ? item.bot.profile.name : item.room.name);

it.effect("orders pinned first, then what calls for the operator, then the latest activity", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const entries = yield* Entries;
    const roster = yield* Roster;
    const create = (name: string) =>
      TestClock.adjust("1 second").pipe(
        Effect.andThen(bots.create({ commandId: command(), draft: { name } })),
      );
    const say = (botId: BotId, author: "bot" | "operator") =>
      TestClock.adjust("1 second").pipe(
        Effect.andThen(
          entries.append({
            target: { _tag: "conversation", botId },
            entry: {
              _tag: "message",
              author: author === "bot" ? { _tag: "bot", botId } : { _tag: "operator" },
              text: "Hello",
              attachments: [],
              mentions: { _tag: "bots", ids: [] },
              delivery: { _tag: "delivered" },
              commandId: null,
            },
          }),
        ),
      );
    yield* create("Quiet");
    const pinned = yield* create("Pinned");
    const recent = yield* create("Recent");
    const unread = yield* create("Unread");
    const hidden = yield* create("Hidden");
    yield* bots.update({ commandId: command(), botId: pinned.id, changes: { pinned: true } });
    yield* bots.update({ commandId: command(), botId: hidden.id, changes: { hidden: true } });
    yield* say(unread.id, "bot");
    yield* say(recent.id, "operator");
    yield* say(hidden.id, "operator");

    const items = yield* roster.items;

    assert.deepStrictEqual(items.map(nameOf), ["Pinned", "Unread", "Hidden", "Recent", "Quiet"]);
    assert.deepStrictEqual(items.filter((item) => item.unread).map(nameOf), ["Unread"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "previews a bot's work by the step that says what it did, not the plan it updated last",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const roster = yield* Roster;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Run the tests.");
      const turnId = yield* nextTurn(bot.id);
      const at = yield* DateTime.now;
      const step = (id: string, kind: WorkStep["kind"], tool: WorkTool | null, label: string) =>
        control.step({
          sessionId: session,
          turnId,
          step: {
            id: WorkStepId.make(id),
            kind,
            tool,
            label,
            status: "completed",
            startedAt: at,
            finishedAt: at,
          },
        });
      yield* step("step-1", "command", null, "pnpm test");
      yield* step("step-2", "tool", "plan", "Updated its plan");
      yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
      yield* turnEnded(bot.id);
      yield* until(
        awaitEntry(bot.id, "work-fold").pipe(Effect.map((fold) => fold.status._tag === "finished")),
      );

      const items = yield* roster.items;
      const item = items.find((found) => found._tag === "bot" && found.bot.id === bot.id);
      assert.strictEqual(item?.lastEntry?.kind, "work-fold");
      assert.deepStrictEqual(item?.lastEntry?.step, {
        kind: "command",
        tool: null,
        label: "pnpm test",
      });
    }).pipe(Effect.provide(TestDomain.layer)),
);
