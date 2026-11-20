// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

/**
 * Runs an effect in one transaction of `sql`. The database is the server's
 * own: a failure to read or write it is a defect, never a typed error a caller
 * handles. Nested calls join the outer transaction.
 */
export const transactional =
  (sql: SqlClient.SqlClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, SqlError.SqlError>, R> =>
    sql
      .withTransaction(effect)
      .pipe(Effect.catchIf(SqlError.isSqlError, Effect.die, (error) => Effect.fail(error)));
