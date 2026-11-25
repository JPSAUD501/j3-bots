// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, type MessageEntry, type RoomId } from "@j3-bots/contracts";
import {
  renderRoomMovedOn,
  renderRoomRead,
  type RoomMovedOn,
  roomMovedOnFits,
  type RoomRead,
  type RoomReadEntry,
  roomReadFits,
  type TeammateRef,
} from "@j3-bots/prompts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { BotStore } from "../bots/BotStore.ts";
import type { Entries } from "../entries/Entries.ts";
import type { SettingsStore } from "../settings/SettingsStore.ts";
import { longestFitting, operatorZone, ROOM_ENTRIES_READ } from "./envelopes.ts";
import { roomSeen, type SessionCall } from "./roomSeen.ts";

/** The call a room is read or posted to from, whose session's view of the room counts. */
export interface RoomReader extends SessionCall {
  readonly botId: BotId;
}

/** The room as a read or a refusal names it. */
export interface ReadRoom {
  readonly id: RoomId;
  readonly name: string;
  readonly archived: boolean;
}

/** How many messages a search reads at a time, so a long room is never held whole. */
const SEARCH_PAGE = 500;

/** Entries in room order, with the newest last: at least that one. */
type NewestLast = readonly [...Array<RoomReadEntry>, RoomReadEntry];

const MessageRow = Schema.Struct({ id: EntryId, position: Schema.Int });
const SearchRow = Schema.Struct({
  id: EntryId,
  position: Schema.Int,
  author_bot_id: Schema.NullOr(BotId),
  text: Schema.NullOr(Schema.String),
});

/**
 * Text as a search compares it: case and accents set aside, so "relatório"
 * matches "RELATORIO".
 */
const folded = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * A bot's reads of its rooms and the check of its posts there
 * (`docs/architecture/server.md`, What a bot has seen of a room): a read
 * shows the room's messages, a refusal what the bot missed, each framed as
 * an envelope frames room entries, and either records, for the turn's
 * session, how far it was shown.
 */
export const roomReads = (
  sql: SqlClient.SqlClient,
  entries: Entries["Service"],
  bots: BotStore["Service"],
  settings: SettingsStore["Service"],
) => {
  const seen = roomSeen(sql);
  const zoneOf = operatorZone(settings);

  /** The place of the room's newest entry, of any kind. */
  const roomEnd = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ end: Schema.NullOr(Schema.Int) }),
    execute: (roomId) => sql`SELECT MAX(position) AS end FROM entries WHERE room_id = ${roomId}`,
  });

  /** A teammate as an envelope names them, also once they were deleted. */
  const teammateRef = Effect.fn("roomReads.teammateRef")(function* (botId: BotId) {
    return Option.match(yield* bots.find(botId), {
      onNone: (): TeammateRef => ({ id: botId, name: "A former teammate", title: "" }),
      onSome: ({ bot }): TeammateRef => ({
        id: bot.id,
        name: bot.profile.name,
        title: bot.profile.title,
      }),
    });
  });

  /**
   * The messages, in the order given, as a read shows them, each with its
   * place in the room; one gone since is left out.
   */
  const shownAs = Effect.fn("roomReads.shownAs")(function* (
    reader: RoomReader,
    rows: ReadonlyArray<typeof MessageRow.Type>,
  ) {
    const { operatorName } = yield* settings.get;
    const shown: Array<{ readonly entry: RoomReadEntry; readonly position: number }> = [];
    for (const { id, position } of rows) {
      const found = yield* entries.find(id);
      if (Option.isNone(found) || found.value.entry._tag !== "message") continue;
      const message: MessageEntry = found.value.entry;
      const mentions =
        message.mentions._tag === "everyone"
          ? ("everyone" as const)
          : (yield* Effect.forEach(message.mentions.ids, teammateRef)).map((ref) => ref.name);
      const author: RoomReadEntry["author"] =
        message.author._tag !== "bot"
          ? { type: "user", name: operatorName }
          : message.author.botId === reader.botId
            ? { type: "you" }
            : { type: "teammate", teammate: yield* teammateRef(message.author.botId) };
      shown.push({
        entry: {
          author,
          at: message.createdAt,
          text: message.text,
          mentions,
          files: message.attachments.map((file) => file.name),
        },
        position,
      });
    }
    return shown;
  });

  /**
   * The newest of `newestFirst` that `fits` takes, oldest first: at least the
   * newest, as an envelope's entry always goes.
   */
  const newestThatFit = (
    newestFirst: readonly [RoomReadEntry, ...Array<RoomReadEntry>],
    fits: (shown: NewestLast) => boolean,
  ): NewestLast => {
    const [latest, ...older] = newestFirst;
    const newest = (count: number): NewestLast => [
      ...older.slice(0, count - 1).toReversed(),
      latest,
    ];
    return newest(longestFitting(newestFirst.length, (count) => fits(newest(count))));
  };

  /** Records that the reader's call was shown the room through its newest entry. */
  const shownThroughEnd = Effect.fn("roomReads.shownThroughEnd")(function* (
    reader: RoomReader,
    roomId: RoomId,
  ) {
    const { end } = yield* roomEnd(roomId).pipe(Effect.orDie);
    if (end === null) return;
    yield* seen.record(reader, roomId, end);
  });

  /** What others wrote in the room after `through`: what a session that saw that far has not seen. */
  const othersAfter = (reader: RoomReader, roomId: RoomId, through: number | null) => sql`
    room_id = ${roomId} AND kind = 'message' AND position > ${through ?? -1}
    AND (author_bot_id IS NULL OR author_bot_id <> ${reader.botId})
  `;

  /**
   * Whether a read whose oldest message is at `oldest` showed the reader's
   * session everything others wrote in the room that it had not seen. A read
   * of fewer messages than that, for its `count` or its size, leaves some
   * out: they stay unseen, for the next envelope or refusal to carry.
   */
  const showedAllUnseen = Effect.fn("roomReads.showedAllUnseen")(function* (
    reader: RoomReader,
    roomId: RoomId,
    oldest: number,
  ) {
    const through = yield* seen.throughCall(reader, roomId);
    const [left] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM entries
      WHERE ${othersAfter(reader, roomId, through)} AND position < ${oldest}
    `;
    return (left?.n ?? 0) === 0;
  }, Effect.orDie);

  /** The room's newest `count` messages, newest first, and how many it holds. */
  const newestOf = Effect.fn("roomReads.newestOf")(function* (roomId: RoomId, count: number) {
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: MessageRow,
      execute: () => sql`
        SELECT id, position FROM entries WHERE room_id = ${roomId} AND kind = 'message'
        ORDER BY position DESC LIMIT ${count}
      `,
    })(undefined);
    const [all] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM entries WHERE room_id = ${roomId} AND kind = 'message'
    `;
    return { rows, total: all?.n ?? 0 };
  }, Effect.orDie);

  /**
   * The room's newest `count` messages that match `search`, newest
   * first, and how many match. The text is folded here, not in SQL, whose
   * case folding knows only ASCII, a page of messages at a time.
   */
  const matching = Effect.fn("roomReads.matching")(function* (
    reader: RoomReader,
    roomId: RoomId,
    search: string,
    count: number,
  ) {
    const page = SqlSchema.findAll({
      Request: Schema.NullOr(Schema.Int),
      Result: SearchRow,
      execute: (before) => sql`
        SELECT id, position, author_bot_id, json_extract(body_json, '$.text') AS text
        FROM entries
        WHERE room_id = ${roomId} AND kind = 'message'
          ${before === null ? sql`` : sql`AND position < ${before}`}
        ORDER BY position DESC LIMIT ${SEARCH_PAGE}
      `,
    });
    const wanted = folded(search);
    const { operatorName } = yield* settings.get;
    const names = new Map<BotId, string>();
    const nameOf = Effect.fn("roomReads.nameOf")(function* (botId: BotId | null) {
      if (botId === null) return operatorName ?? "";
      const known = names.get(botId);
      if (known !== undefined) return known;
      const { name } = yield* teammateRef(botId);
      names.set(botId, name);
      return name;
    });
    const found: Array<typeof MessageRow.Type> = [];
    let total = 0;
    let before: number | null = null;
    for (;;) {
      const rows: ReadonlyArray<typeof SearchRow.Type> = yield* page(before).pipe(Effect.orDie);
      for (const row of rows) {
        const name = yield* nameOf(row.author_bot_id);
        if (folded(row.text ?? "").includes(wanted) || folded(name).includes(wanted)) {
          total += 1;
          if (found.length < count) found.push({ id: row.id, position: row.position });
        }
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < SEARCH_PAGE) break;
      before = last.position;
    }
    return { rows: found, total };
  });

  /**
   * `read_room`: the room's newest messages, or those that match a search,
   * at most `count`, within `ROOM_READ_LIMIT`. A read of the newest that
   * showed everything others wrote there since the session last saw the room
   * leaves it having seen the room through its newest entry, as after an
   * envelope. One that showed fewer, and a search, which shows a selection,
   * record nothing.
   */
  const read = Effect.fn("roomReads.read")(function* (
    reader: RoomReader,
    room: ReadRoom,
    input: { readonly search: string | null; readonly count: number },
  ) {
    const found =
      input.search === null
        ? yield* newestOf(room.id, input.count)
        : yield* matching(reader, room.id, input.search, input.count);
    const newestFirst = yield* shownAs(reader, found.rows);
    const [latest, ...older] = newestFirst.map(({ entry }) => entry);
    const base = {
      at: yield* DateTime.now,
      timeZone: yield* zoneOf,
      room,
      search: input.search,
    };
    const readOf = (shown: ReadonlyArray<RoomReadEntry>): RoomRead => ({
      ...base,
      entries: shown,
      earlier: found.total - shown.length,
      cut: shown.length < older.length + 1,
    });
    const shown =
      latest === undefined
        ? []
        : newestThatFit([latest, ...older], (candidate) => roomReadFits(readOf(candidate)));
    // Newest first, the oldest message shown is the last of those that fit.
    const oldest = newestFirst[shown.length - 1]?.position;
    if (
      input.search === null &&
      (oldest === undefined || (yield* showedAllUnseen(reader, room.id, oldest)))
    ) {
      yield* shownThroughEnd(reader, room.id);
    }
    return yield* renderRoomRead(readOf(shown)).pipe(Effect.provide(SecureRandom.layerWebCrypto));
  });

  /**
   * Why a post to the room from outside its own turn may not go out: the
   * messages of others there that the reader's session has not seen, the
   * newest that fit, framed as an envelope frames them, or `null` when it
   * has seen them all. Once shown them, the session has seen the room
   * through its newest entry, so the same post sent again goes out unless
   * something newer arrived meanwhile.
   */
  const movedOn = Effect.fn("roomReads.movedOn")(function* (
    reader: RoomReader,
    room: Omit<ReadRoom, "archived">,
  ) {
    const through = yield* seen.throughCall(reader, room.id);
    const unseen = othersAfter(reader, room.id, through);
    const newest = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: MessageRow,
      execute: () => sql`
        SELECT id, position FROM entries WHERE ${unseen}
        ORDER BY position DESC LIMIT ${ROOM_ENTRIES_READ}
      `,
    })(undefined).pipe(Effect.orDie);
    const [latest, ...older] = (yield* shownAs(reader, newest)).map(({ entry }) => entry);
    if (latest === undefined) return null;
    const [count] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM entries WHERE ${unseen}
    `.pipe(Effect.orDie);
    const total = count?.n ?? 0;
    const base = { at: yield* DateTime.now, timeZone: yield* zoneOf, room };
    const refusalOf = (shown: NewestLast): RoomMovedOn => ({
      ...base,
      entries: shown,
      omitted: total - shown.length,
    });
    const refusal = refusalOf(
      newestThatFit([latest, ...older], (shown) => roomMovedOnFits(refusalOf(shown))),
    );
    yield* shownThroughEnd(reader, room.id);
    return yield* renderRoomMovedOn(refusal).pipe(Effect.provide(SecureRandom.layerWebCrypto));
  });

  return { read, movedOn };
};
