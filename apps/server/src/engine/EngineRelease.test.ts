// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestDatabase from "../testing/database.ts";
import { claimEngineRelease, EngineDataNewer } from "./EngineRelease.ts";

const recorded = SqlClient.SqlClient.use(
  (sql) => sql<{ readonly version: string }>`SELECT version FROM engine_release`,
);

it.layer(TestDatabase.layer)("the engine release on the home's data", (it) => {
  it.effect("records each newer engine, and refuses an older one, keeping the record", () =>
    Effect.gen(function* () {
      yield* claimEngineRelease("0.1.11");
      yield* claimEngineRelease("0.1.13");
      assert.deepStrictEqual(yield* recorded, [{ version: "0.1.13" }]);

      const older = yield* Effect.flip(claimEngineRelease("0.1.11"));
      assert.deepStrictEqual(older, new EngineDataNewer({ recorded: "0.1.13", pinned: "0.1.11" }));
      assert.deepStrictEqual(yield* recorded, [{ version: "0.1.13" }]);

      yield* claimEngineRelease("0.1.13");
      assert.deepStrictEqual(yield* recorded, [{ version: "0.1.13" }]);
    }),
  );
});
