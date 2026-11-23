// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, NotFound, type Section, SectionId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Bots } from "../bots/Bots.ts";
import { Roster } from "../roster/Roster.ts";
import * as TestDomain from "../testing/domain.ts";
import { createBot, until } from "../testing/turns.ts";
import { Sections } from "./Sections.ts";

let commands = 0;
const command = () => CommandId.make(`sections-${++commands}`);

/** What a roster subscriber holds: the sections it was sent last, and each bot's section. */
interface Seen {
  readonly sections: ReadonlyArray<Section> | null;
  readonly sectionOf: ReadonlyMap<BotId, SectionId | null>;
}

const watchRoster = Effect.gen(function* () {
  const seen = yield* Ref.make<Seen>({ sections: null, sectionOf: new Map() });
  yield* (yield* Roster).subscribe.pipe(
    Stream.runForEach((frame) =>
      Ref.update(seen, (before) => {
        const sectionOf = new Map(frame._tag === "snapshot" ? [] : before.sectionOf);
        for (const item of frame._tag === "snapshot" ? frame.items : frame.upsert) {
          if (item._tag === "bot") sectionOf.set(item.bot.id, item.bot.sectionId);
        }
        return { sections: frame.sections ?? before.sections, sectionOf };
      }),
    ),
    Effect.forkChild({ startImmediately: true }),
  );
  yield* until(Effect.map(Ref.get(seen), (now) => now.sections !== null));
  return seen;
});

const namesOf = (sections: ReadonlyArray<Section> | null) =>
  (sections ?? []).map((section) => section.name);

it.effect(
  "keeps sections in the operator's order, and deleting one leaves its bots in no section",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const sections = yield* Sections;
      const ana = yield* createBot("Ana");
      const bia = yield* createBot("Bia");
      const seen = yield* watchRoster;

      const work = yield* sections.create({ commandId: command(), name: "Work", botId: ana.id });
      const home = yield* sections.create({ commandId: command(), name: "Home" });
      const later = yield* sections.create({ commandId: command(), name: "Later" });
      yield* sections.update({ commandId: command(), sectionId: later.id, before: work.id });
      yield* sections.update({ commandId: command(), sectionId: work.id, before: null });
      yield* sections.update({ commandId: command(), sectionId: home.id, name: "Family" });
      yield* bots.update({ commandId: command(), botId: bia.id, changes: { sectionId: work.id } });

      assert.deepStrictEqual(namesOf(yield* sections.list), ["Later", "Family", "Work"]);
      yield* until(
        Effect.map(
          Ref.get(seen),
          (now) =>
            namesOf(now.sections).join() === "Later,Family,Work" &&
            now.sectionOf.get(ana.id) === work.id &&
            now.sectionOf.get(bia.id) === work.id,
        ),
      );

      yield* sections.remove({ commandId: command(), sectionId: work.id });

      assert.deepStrictEqual(namesOf(yield* sections.list), ["Later", "Family"]);
      yield* until(
        Effect.map(
          Ref.get(seen),
          (now) =>
            namesOf(now.sections).join() === "Later,Family" &&
            now.sectionOf.get(ana.id) === null &&
            now.sectionOf.get(bia.id) === null,
        ),
      );
      const items = yield* (yield* Roster).items;
      assert.deepStrictEqual(
        items.flatMap((item) => (item._tag === "bot" ? [item.bot.profile.name] : [])).toSorted(),
        ["Ana", "Bia"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("refuses a section that does not exist, changing nothing", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const sections = yield* Sections;
    const ana = yield* createBot("Ana");
    const gone = SectionId.make("section_gone");

    const moved = yield* bots
      .update({ commandId: command(), botId: ana.id, changes: { sectionId: gone } })
      .pipe(Effect.flip);
    const placed = yield* sections.create({ commandId: command(), name: "Work" }).pipe(
      Effect.flatMap((work) =>
        sections.update({ commandId: command(), sectionId: work.id, before: gone }),
      ),
      Effect.flip,
    );

    assert.deepStrictEqual(moved, new NotFound({ resource: "section" }));
    assert.deepStrictEqual(placed, new NotFound({ resource: "section" }));
    const items = yield* (yield* Roster).items;
    const item = items.find((found) => found._tag === "bot" && found.bot.id === ana.id);
    assert.strictEqual(item?._tag === "bot" ? item.bot.sectionId : undefined, null);
  }).pipe(Effect.provide(TestDomain.layer)),
);
