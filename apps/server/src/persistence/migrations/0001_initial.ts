// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Times are ISO-8601 UTC text. Kind-specific fields live in `*_json` columns and
// are decoded with the schemas in @j3-bots/contracts. Engine identifiers
// (`engine_*` columns and event cursors) are opaque values from
// @j3-bots/engine-t3, stored and never parsed. Secret values have no column
// anywhere: they pass from the client to the engine without being stored.
//
// An audience is where a bot's speech goes: `conversation` (the bot's own
// conversation with the operator) or `room` with its room. A room audience
// whose room was deleted keeps `room` with a null room id: nothing is delivered
// to it.

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The operator's preferences: always exactly one row.
  yield* sql`
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      time_zone TEXT NOT NULL,
      hop_limit INTEGER NOT NULL CHECK (hop_limit >= 1),
      fan_out_limit INTEGER NOT NULL CHECK (fan_out_limit >= 1),
      concurrent_turns INTEGER NOT NULL CHECK (concurrent_turns >= 1),
      notification_previews INTEGER NOT NULL CHECK (notification_previews IN (0, 1)),
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO settings (
      id, time_zone, hop_limit, fan_out_limit, concurrent_turns, notification_previews, updated_at
    ) VALUES (1, 'UTC', 4, 1, 2, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;

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
      engine_project_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX bots_one_primary ON bots (is_primary) WHERE is_primary = 1`;

  // One per bot. "Unread" is entries ordered after the read mark, nothing else.
  yield* sql`
    CREATE TABLE conversations (
      bot_id TEXT PRIMARY KEY REFERENCES bots (id) ON DELETE CASCADE,
      read_through_order INTEGER,
      created_at TEXT NOT NULL
    )
  `;

  // An active room keeps a host and two to six members (the member count is
  // the server's to keep). Deleting the host's bot fails until the server has
  // handed the room to another member or archived it, which it does in the same
  // transaction (see server.md, Rooms). An archived room may have fewer members
  // and no host.
  yield* sql`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      host_bot_id TEXT REFERENCES bots (id) ON DELETE SET NULL,
      hop_limit INTEGER NOT NULL CHECK (hop_limit >= 1),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      read_through_order INTEGER,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
      CHECK (status = 'archived' OR host_bot_id IS NOT NULL)
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

  // Engine threads that give a bot working context. The id is J3 Bots' own and
  // is the key the engine session is opened with; the engine's id arrives once
  // it has been opened. At most one live main session per bot; side sessions
  // run routines. `admitted_turn_id` is the turn bot tool calls bind to, with
  // the audience its speech goes to.
  yield* sql`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('main', 'side')),
      engine_session_id TEXT UNIQUE,
      prompt_version TEXT NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      events_cursor TEXT,
      admitted_turn_id TEXT,
      admitted_audience TEXT CHECK (admitted_audience IN ('conversation', 'room')),
      admitted_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT,
      CHECK (admitted_turn_id IS NULL OR engine_session_id IS NOT NULL),
      CHECK ((admitted_turn_id IS NULL) = (admitted_audience IS NULL)),
      CHECK (admitted_audience = 'room' OR admitted_room_id IS NULL)
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

  // The operator's Stop of one bot, written with its targets before the engine
  // is called; its id is the command id. A target is every session of the bot
  // with a turn, waiting turns or background work when the Stop was recorded.
  // Its `engine_key` is derived from the Stop and the session, so a retried Stop
  // sends the same command. The Stop is finished when every target is stopped.
  yield* sql`
    CREATE TABLE stops (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE stop_targets (
      stop_id TEXT NOT NULL REFERENCES stops (id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      engine_key TEXT NOT NULL UNIQUE,
      stopped_at TEXT,
      PRIMARY KEY (stop_id, session_id)
    )
  `;

  // One message sent into one session: the durable intent behind an engine
  // dispatch, written before the engine is called. Its id is the dispatch's
  // idempotency key. The session, the audience and the envelope never change
  // once written, so every retry sends the same text to the same place.
  //
  // `status`: `intended` until the engine's answer is known (a lost reply
  // leaves it here, to be reconciled with a lookup); `accepted` once the
  // disposition is recorded; `delivered` when its turn started or its steer was
  // read; `finished` with the turn's outcome; `dropped` when a Stop ended it
  // before delivery (a cancelled waiting turn, an unread steer); `abandoned`
  // when the engine proved it was not applied. `disposition` and
  // `disposition_turn_id` are the engine's first answer and never change;
  // `engine_turn_id` is the turn that delivers it, which differs only for a
  // steer the agent never read, moved to its follow-up turn. A dispatch fenced
  // by a Stop is never sent again.
  yield* sql`
    CREATE TABLE dispatches (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('start', 'steer')),
      steer_turn_id TEXT,
      fresh_context INTEGER NOT NULL DEFAULT 0 CHECK (fresh_context IN (0, 1)),
      envelope TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('intended', 'accepted', 'delivered', 'finished', 'dropped', 'abandoned')
      ),
      disposition TEXT CHECK (disposition IN ('started', 'queued', 'steered', 'new-turn')),
      disposition_turn_id TEXT,
      engine_turn_id TEXT,
      fenced_by_stop_id TEXT REFERENCES stops (id) ON DELETE SET NULL,
      outcome_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (audience = 'room' OR audience_room_id IS NULL),
      CHECK ((delivery = 'steer') = (steer_turn_id IS NOT NULL)),
      CHECK (delivery = 'start' OR fresh_context = 0),
      CHECK (
        disposition IS NULL
        OR (delivery = 'start' AND disposition IN ('started', 'queued'))
        OR (delivery = 'steer' AND disposition IN ('steered', 'new-turn'))
      ),
      CHECK ((disposition IS NULL) = (status IN ('intended', 'abandoned'))),
      CHECK ((disposition IS NULL) = (disposition_turn_id IS NULL)),
      CHECK ((disposition IS NULL) = (engine_turn_id IS NULL))
    )
  `;
  // The audience's room is left out: deleting the room clears it.
  yield* sql`
    CREATE TRIGGER dispatches_immutable_intent
    BEFORE UPDATE OF session_id, audience, delivery, steer_turn_id, fresh_context, envelope
    ON dispatches
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the session, audience and envelope it was written with');
    END
  `;
  yield* sql`
    CREATE TRIGGER dispatches_first_disposition
    BEFORE UPDATE OF disposition, disposition_turn_id ON dispatches
    WHEN OLD.disposition IS NOT NULL
      AND (NEW.disposition IS NOT OLD.disposition
        OR NEW.disposition_turn_id IS NOT OLD.disposition_turn_id)
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the engine''s first answer');
    END
  `;
  yield* sql`
    CREATE INDEX dispatches_open ON dispatches (session_id, status)
    WHERE status IN ('intended', 'accepted', 'delivered')
  `;
  // A turn delivers at most one dispatch of its own; steers that ride on it are not its own.
  yield* sql`
    CREATE UNIQUE INDEX dispatches_turn ON dispatches (session_id, engine_turn_id)
    WHERE engine_turn_id IS NOT NULL
      AND NOT (disposition = 'steered' AND engine_turn_id = disposition_turn_id)
  `;

  // Everything a bot does starts as a wake, recorded with the entry that
  // caused it. J3 Bots holds pending wakes itself and coalesces a bot's
  // pending wakes of one kind and one audience into one dispatch, only when its
  // session can take it.
  yield* sql`
    CREATE TABLE wakes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'room', 'bot', 'routine', 'system')),
      priority INTEGER NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL,
      hops INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'finished', 'cancelled')),
      dispatch_id TEXT REFERENCES dispatches (id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status NOT IN ('dispatched', 'finished') OR dispatch_id IS NOT NULL),
      CHECK (audience = 'room' OR audience_room_id IS NULL),
      CHECK (kind <> 'room' OR audience = 'room')
    )
  `;
  yield* sql`
    CREATE INDEX wakes_pending ON wakes (bot_id, priority, created_at) WHERE status = 'pending'
  `;
  yield* sql`CREATE INDEX wakes_dispatch ON wakes (dispatch_id) WHERE dispatch_id IS NOT NULL`;

  // Messages and cards, in a conversation or in a room. `position` is the
  // entry's order in its target, assigned once; `seq` only says when it was
  // written. A bot author's id outlives the bot, so it has no foreign key.
  yield* sql`
    CREATE TABLE entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      conversation_bot_id TEXT REFERENCES conversations (bot_id) ON DELETE CASCADE,
      room_id TEXT REFERENCES rooms (id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      kind TEXT NOT NULL CHECK (
        kind IN (
          'message', 'question', 'approval', 'secret-request', 'work-fold', 'notice', 'handoff',
          'routine-change'
        )
      ),
      author_kind TEXT NOT NULL CHECK (author_kind IN ('operator', 'bot', 'system')),
      author_bot_id TEXT,
      wake_id TEXT REFERENCES wakes (id) ON DELETE SET NULL,
      command_id TEXT UNIQUE,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((conversation_bot_id IS NULL) <> (room_id IS NULL)),
      CHECK ((author_kind = 'bot') = (author_bot_id IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX entries_conversation ON entries (conversation_bot_id, position)
    WHERE conversation_bot_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX entries_room ON entries (room_id, position) WHERE room_id IS NOT NULL
  `;
  yield* sql`CREATE INDEX entries_wake ON entries (wake_id) WHERE wake_id IS NOT NULL`;
  yield* sql`
    CREATE TRIGGER entries_fixed_place
    BEFORE UPDATE OF conversation_bot_id, room_id, position, kind ON entries
    BEGIN
      SELECT RAISE(ABORT, 'an entry keeps its target, its place and its kind');
    END
  `;

  // An `ask` card: the wake that asked, the audience of the turn that asked
  // (where the answer's turn delivers), and the wake the answer created, set in
  // the same transaction as the answer.
  yield* sql`
    CREATE TABLE ask_cards (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      origin_wake_id TEXT REFERENCES wakes (id) ON DELETE SET NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      follow_up_wake_id TEXT UNIQUE REFERENCES wakes (id) ON DELETE SET NULL,
      CHECK (audience = 'room' OR audience_room_id IS NULL)
    )
  `;

  // A card for something the engine holds a turn on: an approval, an engine
  // question or a secret request. It closes with the request.
  yield* sql`
    CREATE TABLE engine_requests (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      engine_request_id TEXT NOT NULL,
      engine_turn_id TEXT NOT NULL,
      UNIQUE (session_id, engine_request_id)
    )
  `;

  // What a side session did, for the bot's next envelope in its main session.
  // `consumed_dispatch_id` is the dispatch whose envelope carries it. Abandoning
  // or dropping that dispatch clears it again, in the same transaction, so the
  // next envelope carries it instead. Held messages work the same way.
  yield* sql`
    CREATE TABLE catch_up_notes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_dispatch_id TEXT REFERENCES dispatches (id) ON DELETE SET NULL
    )
  `;
  yield* sql`
    CREATE INDEX catch_up_notes_pending ON catch_up_notes (bot_id, created_at)
    WHERE consumed_dispatch_id IS NULL
  `;

  // A non-urgent teammate message, held for the top of the recipient's next
  // envelope. The sender's id outlives the sender.
  yield* sql`
    CREATE TABLE held_messages (
      id TEXT PRIMARY KEY,
      recipient_bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      sender_bot_id TEXT NOT NULL,
      handoff_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      hops INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      consumed_dispatch_id TEXT REFERENCES dispatches (id) ON DELETE SET NULL
    )
  `;
  yield* sql`
    CREATE INDEX held_messages_pending ON held_messages (recipient_bot_id, created_at)
    WHERE consumed_dispatch_id IS NULL
  `;

  // File bytes, stored once per digest under `<J3_HOME>/attachments/`, at
  // `storage_path` relative to it. Never empty.
  yield* sql`
    CREATE TABLE blobs (
      sha256 TEXT PRIMARY KEY,
      size INTEGER NOT NULL CHECK (size >= 1),
      storage_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `;

  // Files the operator sent and files bots delivered: a name and a media type
  // over a blob, so the same bytes can be sent twice under different names and
  // referenced from different entries. A deleted bot's files stay with the room
  // messages that carry them.
  yield* sql`
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL REFERENCES blobs (sha256),
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('operator', 'bot')),
      bot_id TEXT REFERENCES bots (id) ON DELETE SET NULL,
      entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      CHECK (source = 'bot' OR bot_id IS NULL)
    )
  `;
  yield* sql`CREATE INDEX attachments_blob ON attachments (sha256)`;
  yield* sql`CREATE INDEX attachments_bot ON attachments (bot_id, created_at) WHERE bot_id IS NOT NULL`;
  yield* sql`CREATE INDEX attachments_entry ON attachments (entry_id) WHERE entry_id IS NOT NULL`;

  // The files a dispatch carries, in order, fixed with the dispatch. A file is
  // staged in the engine before the first send; the engine's id for it is kept,
  // so a retry names the same staged file, until `usable_until` passes while
  // the dispatch is still unsent and it is staged again.
  yield* sql`
    CREATE TABLE dispatch_attachments (
      dispatch_id TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      attachment_id TEXT NOT NULL REFERENCES attachments (id),
      engine_attachment_id TEXT,
      usable_until TEXT,
      PRIMARY KEY (dispatch_id, position),
      CHECK ((engine_attachment_id IS NULL) = (usable_until IS NULL))
    )
  `;

  // A bot tool call, pinned to the turn it came from. The id is the bridge's id
  // for the call, which it reuses on every retry of the forward, so a retry acts
  // for the same turn and audience and returns the stored result.
  yield* sql`
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      engine_turn_id TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      tool TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      CHECK (audience = 'room' OR audience_room_id IS NULL)
    )
  `;

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

  // What resumable subscriptions resume from. Each change to something a client
  // renders appends a row in its scope (`conversation:<bot>`, `room:<room>`,
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
