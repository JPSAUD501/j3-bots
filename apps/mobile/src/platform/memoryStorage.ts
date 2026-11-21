// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the app's SQLite code runs in tests over Node's own SQLite, in place of expo-sqlite.
import * as NodeSqlite from "node:sqlite";
import type { SecureValue, SqlDatabase, SqlTransaction } from "./storage.ts";

// The app's storage in memory, for its tests.

/** A database in memory, over Node's SQLite, with the transactions expo-sqlite gives the app. */
export const memoryDatabase = (): SqlDatabase => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const sql: SqlTransaction = {
    all: async (text, params = []) => db.prepare(text).all(...params),
    run: async (text, params = []) => {
      db.prepare(text).run(...params);
    },
  };
  return {
    transaction: async (work) => {
      db.exec("BEGIN");
      try {
        const result = await work(sql);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
};

/**
 * Secure storage in memory, holding `held` at first, which fails to write
 * while `failing` says so.
 */
export const memorySecure = (
  options: { readonly held?: string; readonly failing?: () => boolean } = {},
): SecureValue => {
  let held = options.held ?? null;
  return {
    get: async () => held,
    set: async (value) => {
      if (options.failing?.() === true) throw new Error("the keystore refused");
      held = value;
    },
    remove: async () => {
      held = null;
    },
  };
};
