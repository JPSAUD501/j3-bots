import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runMigrations } from "./Migrations.ts";

it.layer(SqliteClient.layer({ filename: ":memory:" }))("migrations", (it) => {
  it.effect("apply to an empty database, then find nothing left to apply", () =>
    Effect.gen(function* () {
      const first = yield* runMigrations();
      assert.deepStrictEqual(
        first.map(([id]) => id),
        [1],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
