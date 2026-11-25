// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  type BotId,
  type Entry,
  EntryOrder,
  type Mentions,
  type Notice,
  type RoomId,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Entries } from "../entries/Entries.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import {
  admittedTurn,
  command,
  createBot,
  engineSession,
  flushed,
  received,
  stopSettled,
  turnEnded,
} from "./turns.ts";

/** A member as a test drives it: the bot and the engine session it works in. */
export interface Member {
  readonly bot: Bot;
  readonly session: SessionId;
}

/** A new bot past its first turn, as a member to drive. */
export const member = (name: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    return { bot, session: yield* engineSession(bot.id) } satisfies Member;
  });

/** A room of these members, in this order: `first`, then `others`. */
export const roomWith = (first: Member, others: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    return yield* (yield* Rooms).create({
      commandId: command(),
      name: "Launch",
      members: [first, ...others].map((one) => one.bot.id),
    });
  });

/** The operator archives the room, or takes it out of the archive. */
export const archive = (roomId: RoomId, archived: boolean) =>
  Effect.gen(function* () {
    yield* (yield* Rooms).update({ commandId: command(), roomId, changes: { archived } });
  });

/** The operator stops the room's work, and the Stop has settled in the engine. */
export const stopRoom = (roomId: RoomId) =>
  Effect.gen(function* () {
    yield* (yield* Rooms).stop({ commandId: command(), roomId });
    yield* stopSettled;
  });

/** The operator writes in the room, and every member's wakes that can go have gone. */
export const operatorWrites = (
  roomId: RoomId,
  members: ReadonlyArray<Member>,
  text: string,
  mentions: Mentions,
) =>
  Effect.gen(function* () {
    const entryId = yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "room", roomId },
      text,
      attachments: [],
      mentions,
    });
    yield* settle(members);
    return entryId;
  });

/** Every member's session took what it can take now. */
export const settle = (members: ReadonlyArray<Member>) =>
  Effect.forEach(members, (member) => flushed(member.bot.id), { discard: true });

let calls = 0;

/** What a test's `say` passes. */
interface SayArgs {
  readonly text: string;
  readonly mention?: ReadonlyArray<string>;
  readonly attachments?: ReadonlyArray<string>;
  readonly to?: "dm";
  readonly done?: boolean;
}

/** The member, in its running turn, calls `say`: the response the tool gives it. */
export const say = (member: Member, turnId: TurnId, args: SayArgs) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: member.session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `room-call-${++calls}`,
      sessionId: member.session,
      tool: "say",
      arguments: { ...args },
    });
  });

/** The member's running turn ends, and every member's wakes that can go have gone. */
export const finish = (member: Member, turnId: TurnId, members: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: member.session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(member.bot.id);
    yield* settle(members);
  });

/** The envelopes the member's session received, oldest first. */
const envelopes = (member: Member) =>
  Effect.map(received(member.session), (all) => all.map((dispatch) => dispatch.text));

/** The newest envelope the member received. */
export const lastEnvelope = (member: Member) =>
  Effect.map(envelopes(member), (all) => all.at(-1) ?? "");

/** Which members run a turn now, in the order given. */
export const running = (members: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    const names: Array<string> = [];
    for (const member of members) {
      if (Option.isSome(yield* admittedTurn(member.bot.id))) names.push(member.bot.profile.name);
    }
    return names;
  });

/** The room's live work: its dispatches not settled and its turns not finished. */
export const liveRoomWork = (roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT
        (SELECT COUNT(*) FROM dispatches
          WHERE audience_room_id = ${roomId} AND status IN ('intended', 'accepted', 'delivered'))
        + (SELECT COUNT(*) FROM turns WHERE audience_room_id = ${roomId} AND finished_at IS NULL)
        AS n
    `.pipe(Effect.orDie);
    return row?.n ?? 0;
  });

/** How many wakes the room ever gave the bot. */
export const roomWakesOf = (botId: BotId, roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM wakes WHERE bot_id = ${botId} AND audience_room_id = ${roomId}
    `.pipe(Effect.orDie);
    return row?.n ?? 0;
  });

/** The room's entries, oldest first. */
export const roomEntries = (roomId: RoomId) =>
  Effect.gen(function* () {
    const page = yield* (yield* Entries).history({
      target: { _tag: "room", roomId },
      before: EntryOrder.make(Number.MAX_SAFE_INTEGER),
      limit: 500,
    });
    return page.entries;
  });

export const noticesIn = (roomId: RoomId) =>
  Effect.map(roomEntries(roomId), (entries) =>
    entries.flatMap((entry: Entry): ReadonlyArray<Notice> =>
      entry._tag === "notice" ? [entry.notice] : [],
    ),
  );

export const nobody: Mentions = { _tag: "bots", ids: [] };

export const to = (...members: ReadonlyArray<Member>): Mentions => ({
  _tag: "bots",
  ids: members.map((one) => one.bot.id),
});

/** The status of each room wake the bot was given, oldest first. */
export const roomWakeStatuses = (botId: BotId, roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM wakes WHERE bot_id = ${botId} AND audience_room_id = ${roomId}
      ORDER BY rowid
    `.pipe(Effect.orDie);
    return rows.map((row) => row.status);
  });

/** Whether any envelope the member received carries the text. */
export const sawText = (member: Member, text: string) =>
  Effect.map(envelopes(member), (all) => all.some((envelope) => envelope.includes(text)));

/** Each message of the room, oldest first: its text and the round it took. */
export const roundsIn = (roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly text: string; readonly round: number | null }>`
      SELECT json_extract(body_json, '$.text') AS text, room_round AS round FROM entries
      WHERE room_id = ${roomId} AND kind = 'message' ORDER BY position
    `.pipe(Effect.orDie);
    return rows.map((row) => [row.text, row.round] as const);
  });
