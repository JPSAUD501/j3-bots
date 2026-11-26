// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type LittleOne,
  LittleOneId,
  MAX_LITTLE_ONES,
  type Plan,
  type Room,
  type RoomId,
} from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import { finish, member, operatorWrites, roomWith, to } from "../testing/rooms.ts";
import {
  awaitEntry,
  conversation,
  createBot,
  engineSession,
  eventually,
  nextTurn,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotStates } from "./BotStates.ts";
import { shownWork } from "./turnWork.ts";

type Line = readonly [text: string, status: "pending" | "running" | "done"];

const planStep = ([text, status]: Line) => ({ text, status });

const plan = (first: Line, ...rest: ReadonlyArray<Line>): Plan => ({
  steps: [planStep(first), ...rest.map(planStep)],
});

const littleOne = (
  id: string,
  startedAt: DateTime.Utc,
  ended: { readonly status: "done" | "failed"; readonly at: DateTime.Utc } | null,
): LittleOne => ({
  id: LittleOneId.make(id),
  label: `Look into ${id}`,
  status: ended === null ? "working" : ended.status,
  startedAt,
  finishedAt: ended === null ? null : ended.at,
});

/** The room's work by member, as the roster sends it with the room. */
const memberWorkIn = (roomId: RoomId) =>
  Effect.flatMap(Rooms, (rooms) => rooms.find(roomId)).pipe(
    Effect.map((found) =>
      Option.match(found, {
        onNone: () => [],
        onSome: (one: Room) => (one.status === "active" ? one.memberWork : []),
      }),
    ),
  );

/** The bot's latest work fold's work, once it is there. */
const foldWork = (botId: Parameters<typeof awaitEntry>[0]) =>
  awaitEntry(botId, "work-fold").pipe(Effect.map((fold) => fold.work));

it.effect("keeps a private turn's latest plan on its fold, and the last one once it ended", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const states = yield* BotStates;
    const bot = yield* createBot("Ana");
    const sessionId = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Ship the release.");
    const turnId = yield* nextTurn(bot.id);
    const at = yield* DateTime.now;
    const first = plan(["Run the checks", "running"], ["Tag the release", "pending"]);

    yield* control.turnWork({
      sessionId,
      turnId,
      work: { plan: first, littleOnes: [littleOne("tests", at, null)] },
    });
    yield* until(foldWork(bot.id).pipe(Effect.map((work) => work !== null)));
    assert.deepStrictEqual((yield* foldWork(bot.id))?.plan, first);
    const working = yield* states.of(bot.id);
    // A plan and a little one show the bot working before any step of its own.
    assert.isTrue(working._tag === "working" && working.littleOnes === 1);

    yield* TestClock.adjust("1 minute");
    const ended = yield* DateTime.now;
    const last = plan(["Run the checks", "done"], ["Tag the release", "done"]);
    yield* control.turnWork({
      sessionId,
      turnId,
      work: { plan: last, littleOnes: [littleOne("tests", at, { status: "done", at: ended })] },
    });
    yield* control.finishTurn({ sessionId, turnId, outcome: { _tag: "completed" } });
    yield* turnEnded(bot.id);

    const work = yield* eventually(
      awaitEntry(bot.id, "work-fold").pipe(
        Effect.map((fold) =>
          fold.status._tag === "finished" ? Option.some(fold.work) : Option.none(),
        ),
      ),
    );
    assert.deepStrictEqual(work, {
      plan: last,
      littleOnes: {
        ones: [littleOne("tests", at, { status: "done", at: ended })],
        working: 0,
        total: 1,
      },
    });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows a room turn's plan by its member in the room, never in its conversation", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const ana = yield* member("Ana");
    const bo = yield* member("Bo");
    const room = yield* roomWith(ana, [bo]);
    const conversationBefore = yield* conversation(ana.bot.id);
    yield* operatorWrites(room.id, [ana, bo], "Plan the launch.", to(ana));
    const turnId = yield* nextTurn(ana.bot.id);
    const steps = plan(["Draft the post", "running"], ["Pick a date", "pending"]);

    yield* control.turnWork({
      sessionId: ana.session,
      turnId,
      work: { plan: steps, littleOnes: [] },
    });
    const memberWork = memberWorkIn(room.id);
    yield* until(memberWork.pipe(Effect.map((all) => all.length > 0)));
    assert.deepStrictEqual(yield* memberWork, [
      {
        botId: ana.bot.id,
        work: { plan: steps, littleOnes: { ones: [], working: 0, total: 0 } },
      },
    ]);
    const conversationAfter = yield* conversation(ana.bot.id);
    assert.deepStrictEqual(
      conversationAfter.filter((entry) => entry._tag === "work-fold" && entry.work !== null),
      [],
    );
    assert.strictEqual(conversationAfter.length, conversationBefore.length);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps an ended turn's little ones when a later turn takes one up again", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const sessionId = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Review the PR.");
    const first = yield* nextTurn(bot.id);
    const at = yield* DateTime.now;
    const done = littleOne("reviewer", at, { status: "done", at });
    yield* control.turnWork({ sessionId, turnId: first, work: { plan: null, littleOnes: [done] } });
    yield* control.finishTurn({ sessionId, turnId: first, outcome: { _tag: "completed" } });
    yield* turnEnded(bot.id);
    const firstFold = yield* awaitEntry(bot.id, "work-fold");

    yield* sendToBot(bot.id, "Ask the reviewer about the parser.");
    const second = yield* nextTurn(bot.id, first);
    // The engine lists the little one under the later turn alone, the
    // earlier with none, as it does once a subagent is taken up again.
    const again = littleOne("reviewer", at, null);
    yield* control.turnWork({ sessionId, turnId: first, work: { plan: null, littleOnes: [] } });
    yield* control.turnWork({
      sessionId,
      turnId: second,
      work: { plan: null, littleOnes: [again] },
    });
    yield* until(
      awaitEntry(bot.id, "work-fold").pipe(Effect.map((fold) => fold.id !== firstFold.id)),
    );

    const folds = (yield* conversation(bot.id)).flatMap((entry) =>
      entry._tag === "work-fold" ? [entry.work] : [],
    );
    assert.deepStrictEqual(folds, [
      { plan: null, littleOnes: { ones: [done], working: 0, total: 1 } },
      { plan: null, littleOnes: { ones: [again], working: 1, total: 1 } },
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows a little one a member's room turn handed off beside its next turn's plan", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const ana = yield* member("Ana");
    const bo = yield* member("Bo");
    const room = yield* roomWith(ana, [bo]);
    yield* operatorWrites(room.id, [ana, bo], "Find a venue.", to(ana));
    const first = yield* nextTurn(ana.bot.id);
    const at = yield* DateTime.now;
    const scout = littleOne("scout", at, null);
    yield* control.turnWork({
      sessionId: ana.session,
      turnId: first,
      work: { plan: null, littleOnes: [scout] },
    });
    yield* control.startBackgroundWork({ sessionId: ana.session, turnId: first });
    yield* finish(ana, first, [ana, bo]);

    yield* operatorWrites(room.id, [ana, bo], "And draft the invite.", to(ana));
    const second = yield* nextTurn(ana.bot.id, first);
    const steps = plan(["Draft the invite", "running"], ["Send it", "pending"]);
    yield* control.turnWork({
      sessionId: ana.session,
      turnId: second,
      work: { plan: steps, littleOnes: [] },
    });
    yield* until(
      memberWorkIn(room.id).pipe(Effect.map((all) => all.some((one) => one.work.plan !== null))),
    );

    assert.deepStrictEqual(yield* memberWorkIn(room.id), [
      {
        botId: ana.bot.id,
        work: { plan: steps, littleOnes: { ones: [scout], working: 1, total: 1 } },
      },
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends a little one still working as failed when its session is lost", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const sessionId = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Audit the dependencies.");
    const turnId = yield* nextTurn(bot.id);
    const at = yield* DateTime.now;
    yield* control.turnWork({
      sessionId,
      turnId,
      work: { plan: null, littleOnes: [littleOne("licenses", at, null)] },
    });
    // The turn hands the little one off to keep working after it ends.
    yield* control.startBackgroundWork({ sessionId, turnId });
    yield* control.finishTurn({ sessionId, turnId, outcome: { _tag: "completed" } });
    yield* turnEnded(bot.id);
    yield* until(
      foldWork(bot.id).pipe(Effect.map((work) => work?.littleOnes.ones[0]?.status === "working")),
    );

    yield* TestClock.adjust("5 minutes");
    const lostAt = yield* DateTime.now;
    yield* control.loseSession(sessionId);
    const ended = yield* eventually(
      foldWork(bot.id).pipe(
        Effect.map((work) =>
          work?.littleOnes.working === 0 ? Option.some(work.littleOnes) : Option.none(),
        ),
      ),
    );
    assert.deepStrictEqual(ended, {
      ones: [littleOne("licenses", at, { status: "failed", at: lostAt })],
      working: 0,
      total: 1,
    });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("names every little one still working when a turn has more than it lists", () =>
  Effect.gen(function* () {
    const start = yield* DateTime.now;
    const after = (minutes: number) => DateTime.add(start, { minutes });
    // Twenty ended early and in turn, then two that still work.
    const ended = Array.from({ length: 20 }, (_, i) =>
      littleOne(`ended-${i}`, after(i), { status: "done", at: after(i + 1) }),
    );
    const working = [
      littleOne("working-a", after(30), null),
      littleOne("working-b", after(31), null),
    ];

    const work = shownWork({ plan: null, littleOnes: [...ended, ...working] });

    assert.deepStrictEqual(work?.littleOnes.ones, [
      ...ended.slice(20 - (MAX_LITTLE_ONES - working.length)),
      ...working,
    ]);
    assert.deepStrictEqual([work?.littleOnes.working, work?.littleOnes.total], [2, 22]);
  }),
);
