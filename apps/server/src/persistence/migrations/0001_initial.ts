import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Times are ISO-8601 UTC text. Kind-specific fields live in `*_json` columns and
// are decoded with the schemas in @j3-bots/contracts. Engine identifiers
// (`engine_*`, session ids, event cursors) are opaque values from
// @j3-bots/engine-t3, stored and never parsed.

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      avatar_shape TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      job TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      permission_mode TEXT NOT NULL
        CHECK (permission_mode IN ('supervised', 'auto-accept-edits', 'auto', 'full-access')),
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
      workspace_path TEXT NOT NULL UNIQUE,
      engine_project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX bots_one_primary ON bots (is_primary) WHERE is_primary = 1`;

  // One per bot. The operator's read mark drives "unread" in the roster.
  yield* sql`
    CREATE TABLE conversations (
      bot_id TEXT PRIMARY KEY REFERENCES bots (id) ON DELETE CASCADE,
      read_through_entry_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_bot_id TEXT NOT NULL REFERENCES bots (id),
      hop_limit INTEGER NOT NULL CHECK (hop_limit >= 1),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      read_through_entry_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE room_members (
      room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (room_id, bot_id),
      UNIQUE (room_id, position)
    )
  `;

  // Engine threads that give a bot working context. At most one live main
  // session per bot; side sessions run routines.
  yield* sql`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('main', 'side')),
      run_count INTEGER NOT NULL DEFAULT 0,
      events_cursor TEXT,
      created_at TEXT NOT NULL,
      retired_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX sessions_one_main ON sessions (bot_id)
    WHERE purpose = 'main' AND retired_at IS NULL
  `;

  yield* sql`
    CREATE TABLE routines (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      instruction TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      webhook_secret TEXT UNIQUE,
      next_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX routines_due ON routines (next_run_at) WHERE enabled = 1`;

  // Everything a bot does starts as a wake, recorded before it is dispatched.
  // Its id is the idempotency key of the engine dispatch.
  yield* sql`
    CREATE TABLE wakes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'room', 'bot', 'routine', 'system')),
      room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions (id),
      hops INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'dispatched', 'running', 'waiting', 'finished')),
      attempts INTEGER NOT NULL DEFAULT 0,
      engine_turn_id TEXT,
      outcome_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX wakes_open ON wakes (status, created_at) WHERE status <> 'finished'`;
  yield* sql`CREATE INDEX wakes_bot ON wakes (bot_id, created_at)`;

  // Messages and cards, in a conversation or in a room. `seq` orders them.
  yield* sql`
    CREATE TABLE entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      conversation_bot_id TEXT REFERENCES conversations (bot_id) ON DELETE CASCADE,
      room_id TEXT REFERENCES rooms (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('message', 'question', 'approval', 'work-fold', 'notice', 'handoff', 'routine-change')
      ),
      author_kind TEXT NOT NULL CHECK (author_kind IN ('operator', 'bot', 'system')),
      author_bot_id TEXT REFERENCES bots (id) ON DELETE SET NULL,
      wake_id TEXT REFERENCES wakes (id) ON DELETE SET NULL,
      command_id TEXT UNIQUE,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((conversation_bot_id IS NULL) <> (room_id IS NULL)),
      CHECK ((author_kind = 'bot') = (author_bot_id IS NOT NULL))
    )
  `;
  yield* sql`CREATE INDEX entries_conversation ON entries (conversation_bot_id, seq)`;
  yield* sql`CREATE INDEX entries_room ON entries (room_id, seq)`;
  yield* sql`CREATE INDEX entries_wake ON entries (wake_id) WHERE wake_id IS NOT NULL`;

  yield* sql`
    CREATE TABLE routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
      wake_id TEXT REFERENCES wakes (id) ON DELETE SET NULL,
      status TEXT NOT NULL
        CHECK (status IN ('running', 'delivered', 'silent', 'failed', 'skipped')),
      note TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`CREATE INDEX routine_runs_recent ON routine_runs (routine_id, started_at)`;

  yield* sql`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      push_token TEXT,
      notification_prefs_json TEXT NOT NULL DEFAULT '{}',
      paired_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    )
  `;

  // A client command applied once: a retry with the same id returns this result.
  yield* sql`
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // What subscriptions resume from. Each change to something a client renders
  // appends a row in its scope (`roster`, `conversation:<bot>`, `room:<room>`,
  // `routines:<bot>`); a client resumes with the last `seq` it applied. Pruning
  // old rows is safe: a cursor older than what is kept gets a fresh snapshot.
  yield* sql`
    CREATE TABLE changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX changes_scope ON changes (scope, seq)`;
});
