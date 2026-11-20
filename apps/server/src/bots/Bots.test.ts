// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CommandId, EntryOrder, MemoryPath, type Room } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { Entries } from "../entries/Entries.ts";
import { Layout, SYSTEM_PROMPT_FILE } from "../Layout.ts";
import { Memory } from "../memory/Memory.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import { BotStore } from "./BotStore.ts";
import { Bots } from "./Bots.ts";

let commands = 0;
const command = () => CommandId.make(`command-${++commands}`);

const createBot = (name: string, job = "") =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    yield* TestClock.adjust("1 second");
    return yield* bots.create({ commandId: command(), draft: { name, job } });
  });

const activeMembers = (room: Room) => (room.status === "active" ? room.hostId : null);

it.effect("hands a room the deleted bot hosted to the member who joined first among the rest", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const rooms = yield* Rooms;
    const [a, b, c] = yield* Effect.all([createBot("Ana"), createBot("Bia"), createBot("Caio")]);
    const room = yield* rooms.create({
      commandId: command(),
      name: "Launch",
      members: [a.id, b.id, c.id],
      hostId: a.id,
    });

    yield* bots.remove({ commandId: command(), botId: a.id, deleteFiles: false });

    const after = Option.getOrThrow(yield* rooms.find(room.id));
    assert.strictEqual(after.status, "active");
    assert.deepStrictEqual(after.members, [b.id, c.id]);
    assert.strictEqual(activeMembers(after), b.id);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("archives a room left with fewer than two members, keeping what was said there", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const rooms = yield* Rooms;
    const entries = yield* Entries;
    const [a, b] = yield* Effect.all([createBot("Ana"), createBot("Bia")]);
    const room = yield* rooms.create({
      commandId: command(),
      name: "Pair",
      members: [a.id, b.id],
      hostId: b.id,
    });
    const said = yield* entries.append({
      target: { _tag: "room", roomId: room.id },
      entry: {
        _tag: "message",
        author: { _tag: "bot", botId: b.id },
        text: "Shipped.",
        attachments: [],
        mentions: { _tag: "bots", ids: [] },
        delivery: { _tag: "delivered" },
        commandId: null,
      },
    });

    yield* bots.remove({ commandId: command(), botId: b.id, deleteFiles: false });

    const after = Option.getOrThrow(yield* rooms.find(room.id));
    assert.strictEqual(after.status, "archived");
    assert.strictEqual(after.hostId, null);
    assert.deepStrictEqual(after.members, [a.id]);
    const kept = Option.getOrThrow(yield* entries.find(said.id));
    assert.deepStrictEqual(kept.entry.author, { _tag: "bot", botId: b.id });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("removes the conversation and memory but keeps the files unless asked", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const memory = yield* Memory;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bot = yield* createBot("Ana");
    yield* memory.remember({ botId: bot.id, fact: "The repo is j3", tier: "pinned", scope: "bot" });
    const produced = path.join(layout.workspace(bot.id), "files", "report.md");
    yield* fs.writeFileString(produced, "# Report");

    yield* bots.remove({ commandId: command(), botId: bot.id, deleteFiles: false });

    assert.isFalse(yield* fs.exists(layout.botMemory(bot.id)));
    assert.isFalse(yield* fs.exists(path.join(layout.workspace(bot.id), SYSTEM_PROMPT_FILE)));
    assert.isTrue(yield* fs.exists(produced));
    const history = yield* (yield* Entries)
      .history({
        target: { _tag: "conversation", botId: bot.id },
        before: EntryOrder.make(0),
        limit: 1,
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(history));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses to delete while the engine cannot retire the bot's project, changing nothing",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const store = yield* BotStore;
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      yield* control.setReachable(false);

      const exit = yield* bots
        .remove({ commandId: command(), botId: bot.id, deleteFiles: true })
        .pipe(Effect.exit);

      assert.deepStrictEqual(
        Exit.findErrorOption(exit).pipe(Option.map((error) => error._tag)),
        Option.some("Conflict"),
      );
      assert.isTrue(Option.isSome(yield* store.find(bot.id)));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("writes the bot's profile and pinned memory into its generated instructions", () =>
  Effect.gen(function* () {
    const memory = yield* Memory;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bot = yield* createBot("Scout", "Watches the repository for new issues.");
    const system = path.join(layout.workspace(bot.id), SYSTEM_PROMPT_FILE);
    const agents = path.join(layout.workspace(bot.id), "AGENTS.md");

    yield* memory.remember({
      botId: bot.id,
      fact: "The operator reviews pull requests on Fridays",
      tier: "pinned",
      scope: "bot",
    });

    const rendered = yield* fs.readFileString(system);
    assert.include(rendered, "Scout");
    assert.include(rendered, "Watches the repository for new issues.");
    assert.include(rendered, "The operator reviews pull requests on Fridays");
    assert.include(yield* fs.readFileString(agents), "Watches the repository for new issues.");
    assert.include(
      (yield* memory.read({ _tag: "bot", botId: bot.id }, MemoryPath.make("profile.md"))).text,
      "The operator reviews pull requests on Fridays",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);
