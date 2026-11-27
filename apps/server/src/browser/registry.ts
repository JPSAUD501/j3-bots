// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, BrowserTabOpener, BrowserTabRef } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// The stored half of the tab registry (`browser_tabs`, migration 0072): what
// a tab keeps across a restart. Where it runs, what its page shows now and
// who acts on it live only in memory, with the hosts.

/** A tab as stored. */
export interface StoredTab {
  readonly ref: BrowserTabRef;
  readonly url: string;
  readonly title: string;
  readonly openedBy: BrowserTabOpener;
  /** The bots that used it, the most recent first. */
  readonly onIt: ReadonlyArray<BotId>;
  readonly createdAt: number;
  readonly usedAt: number;
}

const Row = Schema.Struct({
  ref: BrowserTabRef,
  url: Schema.String,
  title: Schema.String,
  opened_by_json: Schema.fromJsonString(BrowserTabOpener),
  on_it_json: Schema.fromJsonString(Schema.Array(BotId)),
  created_at: Schema.Finite,
  used_at: Schema.Finite,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeOpener = Schema.encodeSync(Schema.fromJsonString(BrowserTabOpener));
const encodeOnIt = Schema.encodeSync(Schema.fromJsonString(Schema.Array(BotId)));

export const makeRegistryStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const load = sql`SELECT * FROM browser_tabs ORDER BY created_at`.pipe(
    Effect.flatMap(decodeRows),
    Effect.map((rows) =>
      rows.map((row): StoredTab => ({
        ref: row.ref,
        url: row.url,
        title: row.title,
        openedBy: row.opened_by_json,
        onIt: row.on_it_json,
        createdAt: row.created_at,
        usedAt: row.used_at,
      })),
    ),
    Effect.orDie,
  );

  const save = (tab: StoredTab) =>
    sql`
      INSERT INTO browser_tabs (ref, url, title, opened_by_json, on_it_json, created_at, used_at)
      VALUES (${tab.ref}, ${tab.url}, ${tab.title}, ${encodeOpener(tab.openedBy)},
        ${encodeOnIt(tab.onIt)}, ${tab.createdAt}, ${tab.usedAt})
      ON CONFLICT (ref) DO UPDATE SET
        url = excluded.url, title = excluded.title, on_it_json = excluded.on_it_json,
        used_at = excluded.used_at
    `.pipe(Effect.asVoid, Effect.orDie);

  const remove = (ref: BrowserTabRef) =>
    sql`DELETE FROM browser_tabs WHERE ref = ${ref}`.pipe(Effect.asVoid, Effect.orDie);

  return { load, save, remove } as const;
});
