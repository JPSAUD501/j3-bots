// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandId,
  type Conflict,
  NotFound,
  Section,
  SectionId,
  type SectionName,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { BotStore } from "../bots/BotStore.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { timeText } from "../persistence/columns.ts";

type Name = typeof SectionName.Type;

const SectionRow = Schema.Struct({ id: SectionId, name: Schema.String });

const toSection = (row: typeof SectionRow.Type): Section => ({ id: row.id, name: row.name });

/**
 * The roster's sections: named groups of bots, in the operator's order. A bot
 * names its section (`BotStore`); a section's change reaches the roster as a
 * `sections` change, and each bot it moves as that bot's.
 */
export class Sections extends Context.Service<
  Sections,
  {
    /** Every section, in the operator's order. */
    readonly list: Effect.Effect<ReadonlyArray<Section>>;
    /** Fails with `NotFound("section")` when there is no such section. */
    readonly require: (id: SectionId) => Effect.Effect<Section, NotFound>;
    readonly create: (input: {
      readonly commandId: CommandId;
      readonly name: Name;
      readonly botId?: BotId;
    }) => Effect.Effect<Section, NotFound | Conflict>;
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly sectionId: SectionId;
      readonly name?: Name;
      readonly before?: SectionId | null;
    }) => Effect.Effect<Section, NotFound | Conflict>;
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly sectionId: SectionId;
    }) => Effect.Effect<void, NotFound | Conflict>;
  }
>()("@j3-bots/server/sections/Sections") {}

export const layer = Layer.effect(
  Sections,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* Ids;
    const bots = yield* BotStore;
    const changes = yield* ChangeLog;
    const receipts = yield* CommandReceipts;

    const listRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SectionRow,
      execute: () => sql`SELECT id, name FROM sections ORDER BY position, created_at, id`,
    });
    const findRow = SqlSchema.findOneOption({
      Request: SectionId,
      Result: SectionRow,
      execute: (id) => sql`SELECT id, name FROM sections WHERE id = ${id}`,
    });
    const botsIn = SqlSchema.findAll({
      Request: SectionId,
      Result: Schema.Struct({ id: BotId }),
      execute: (id) => sql`SELECT id FROM bots WHERE section_id = ${id}`,
    });

    const list = listRows(undefined).pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toSection)),
    );

    const require = Effect.fn("Sections.require")(function* (id: SectionId) {
      const row = yield* findRow(id).pipe(Effect.orDie);
      if (Option.isNone(row)) return yield* new NotFound({ resource: "section" });
      return toSection(row.value);
    });

    /**
     * Writes `order` as the sections' positions, from 0. Sections are few and
     * the operator moves one at a time, so every one is written again.
     */
    const renumber = Effect.fn("Sections.renumber")(function* (
      order: ReadonlyArray<SectionId>,
      at: string,
    ) {
      for (const [position, id] of order.entries()) {
        yield* sql`
          UPDATE sections SET position = ${position}, updated_at = ${at}
          WHERE id = ${id} AND position <> ${position}
        `.pipe(Effect.orDie);
      }
    });

    const create = Effect.fn("Sections.create")(function* (input: {
      readonly commandId: CommandId;
      readonly name: Name;
      readonly botId?: BotId;
    }) {
      return yield* receipts.once({
        commandId: input.commandId,
        method: "section.create",
        payload: input,
        result: Section,
        apply: Effect.gen(function* () {
          if (input.botId !== undefined && Option.isNone(yield* bots.find(input.botId))) {
            return yield* new NotFound({ resource: "bot" });
          }
          const id = SectionId.make(yield* ids.make("section"));
          const now = yield* DateTime.now;
          const at = timeText(now);
          yield* sql`
            INSERT INTO sections (id, name, position, created_at, updated_at)
            VALUES (
              ${id}, ${input.name},
              (SELECT COALESCE(MAX(position) + 1, 0) FROM sections), ${at}, ${at}
            )
          `.pipe(Effect.orDie);
          yield* changes.touch({ _tag: "sections" });
          if (input.botId !== undefined) {
            yield* bots.update(input.botId, { sectionId: id }, now, "operator");
            yield* changes.touch({ _tag: "bot", botId: input.botId });
          }
          return { id, name: input.name } satisfies Section;
        }),
      });
    });

    const update = Effect.fn("Sections.update")(function* (input: {
      readonly commandId: CommandId;
      readonly sectionId: SectionId;
      readonly name?: Name;
      readonly before?: SectionId | null;
    }) {
      return yield* receipts.once({
        commandId: input.commandId,
        method: "section.update",
        payload: input,
        result: Section,
        apply: Effect.gen(function* () {
          yield* require(input.sectionId);
          const at = timeText(yield* DateTime.now);
          if (input.name !== undefined) {
            yield* sql`
              UPDATE sections SET name = ${input.name}, updated_at = ${at}
              WHERE id = ${input.sectionId}
            `.pipe(Effect.orDie);
          }
          const { before } = input;
          if (before !== undefined && before !== input.sectionId) {
            if (before !== null) yield* require(before);
            const others = (yield* list)
              .map((section) => section.id)
              .filter((id) => id !== input.sectionId);
            const index = before === null ? others.length : others.indexOf(before);
            yield* renumber(others.toSpliced(index, 0, input.sectionId), at);
          }
          yield* changes.touch({ _tag: "sections" });
          return yield* require(input.sectionId).pipe(Effect.orDie);
        }),
      });
    });

    const remove = Effect.fn("Sections.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly sectionId: SectionId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "section.delete",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          yield* require(input.sectionId);
          // The database moves the bots out (`ON DELETE SET NULL`); each is
          // told as a change of its own, read before they leave.
          const moved = yield* botsIn(input.sectionId).pipe(Effect.orDie);
          yield* sql`DELETE FROM sections WHERE id = ${input.sectionId}`.pipe(Effect.orDie);
          const remaining = (yield* list).map((section) => section.id);
          yield* renumber(remaining, timeText(yield* DateTime.now));
          yield* changes.touch({ _tag: "sections" });
          for (const bot of moved) yield* changes.touch({ _tag: "bot", botId: bot.id });
        }),
      });
    });

    return Sections.of({ list, require, create, update, remove });
  }),
);
