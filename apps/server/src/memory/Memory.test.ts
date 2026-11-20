// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CommandId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import { Memory } from "./Memory.ts";

const createBot = Effect.gen(function* () {
  const bots = yield* Bots;
  return yield* bots.create({ commandId: CommandId.make("create"), draft: { name: "Ana" } });
});

it.effect("records a fact once, in either tier, and refuses what looks like a credential", () =>
  Effect.gen(function* () {
    const memory = yield* Memory;
    const { id: botId } = yield* createBot;
    const remember = (fact: string) => memory.remember({ botId, fact, tier: "log", scope: "bot" });

    const first = yield* remember("Deploys happen on Tuesdays");
    const again = yield* remember("deploys happen on tuesdays");
    const key = yield* remember("The API key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");

    assert.deepStrictEqual(first, { recorded: true });
    assert.deepStrictEqual(again, { recorded: false, reason: "duplicate" });
    assert.deepStrictEqual(key, { recorded: false, reason: "looks-like-a-credential" });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("recalls the bot's own facts and the shared ones, and forgets one", () =>
  Effect.gen(function* () {
    const memory = yield* Memory;
    const { id: botId } = yield* createBot;
    yield* memory.remember({ botId, fact: "Staging runs on the Pi", tier: "log", scope: "bot" });
    yield* memory.remember({
      botId,
      fact: "The operator's staging password lives in their vault",
      tier: "pinned",
      scope: "shared",
    });

    const found = yield* memory.recall({ botId, query: "staging", scope: undefined, limit: 10 });
    const forgotten = yield* memory.forget({ botId, fact: "Staging runs on the Pi", scope: "bot" });
    const after = yield* memory.recall({ botId, query: "staging", scope: "bot", limit: 10 });

    assert.deepStrictEqual(found.map((fact) => fact.scope).toSorted(), ["bot", "shared"]);
    assert.deepStrictEqual(forgotten, { removed: true });
    assert.deepStrictEqual(after, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);
