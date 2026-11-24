// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the server's own database is read as it is, which only node:sqlite does here.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  type EntryTarget,
  HTTP_PATHS,
  J3Rpcs,
  PairRequest,
  PairResult,
  type ReceivedEntry,
  type Room,
  type RoomId,
} from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as AdminClient from "../src/admin/AdminClient.ts";
import { HOME_ENTRIES } from "../src/home/entries.ts";
import { freePort, searchPathWithoutNode } from "../smoke/host.ts";

// Bots build a team on the operator's word, end to end
// (docs/product/experience.md, "Several bots, one goal"): a development
// server of this checkout, in a scratch home, on the pinned engine, with the
// scripted agent calling J3 Bots' own tools through the real `j3` bridge. The
// operator asks the primary bot for a group; in that one turn it creates four
// teammates and starts a room with them, whose kickoff wakes each member in
// turn. Needs the network the first time, to download the engine.

const ENGINE_READY_WITHIN = Duration.minutes(10);
const TEAM_WITHIN = Duration.minutes(3);

const SERVER = `${import.meta.dirname}/../src/bin.ts`;
const SCRIPTED_AGENT = `${import.meta.dirname}/../../../packages/engine-t3/scripted-agent/agent.ts`;

/** The teammates the scripted `team` script creates, in order. */
const TEAM = ["Ana", "Bo", "Cy", "Di"];

const services = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  AdminClient.layer.pipe(Layer.provide(NodeServices.layer)),
);

const TurnRow = Schema.Struct({
  bot_id: Schema.String,
  audience_room_id: Schema.NullOr(Schema.String),
  started_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
});
const decodeTurnRows = Schema.decodeUnknownSync(Schema.Array(TurnRow));
const decodeStatusRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ bot_id: Schema.String, status: Schema.String })),
);

it.layer(services, { excludeTestServices: true })("bots build a team", (it) => {
  it.effect(
    "creates four bots and a room on the operator's word, whose members answer one at a time, with no hello",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scratch = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "j3-team-" }),
        );
        const home = path.join(scratch, "home");
        const userHome = path.join(scratch, "user");
        yield* fs.makeDirectory(userHome);

        // The server, for as long as the test runs; its log goes to the test's.
        // Bots run on the scripted agent only: Claude Code and Codex are
        // stand-ins that fail, so none of the machine's own harnesses runs,
        // nor writes in the scratch home while it is removed.
        const env: Record<string, string> = {
          PATH: yield* searchPathWithoutNode(path.join(scratch, "commands"), {
            claude: "exit 1",
            codex: "exit 1",
            gh: "exit 1",
          }),
          HOME: userHome,
          J3_HOME: home,
          J3_HOST: "127.0.0.1",
          J3_PORT: String(yield* freePort),
          J3_TOOL_PORT: String(yield* freePort),
          J3_ENGINE_PORT: String(yield* freePort),
          J3_SCRIPTED_AGENT: path.resolve(SCRIPTED_AGENT),
        };
        yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          ChildProcess.make(process.execPath, [SERVER, "serve"], {
            env,
            extendEnv: true,
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
            killSignal: "SIGTERM",
            forceKillAfter: "30 seconds",
          }),
        );
        const admin = yield* AdminClient.AdminClient;
        const socket = path.join(home, HOME_ENTRIES.adminSocket);
        const status = yield* admin.status(socket).pipe(
          Effect.flatMap((found) => Effect.fromOption(found)),
          Effect.retry(Schedule.spaced("500 millis")),
          Effect.timeout("1 minute"),
        );
        const origin = `http://127.0.0.1:${status.listener.port}`;

        // A device pairs and opens the client socket.
        const http = yield* HttpClient.HttpClient;
        const grant = yield* admin
          .startPairing(socket, { unlock: false })
          .pipe(Effect.flatMap((found) => Effect.fromOption(found)));
        if (grant._tag !== "granted") return yield* Effect.die("pairing is locked on a new server");
        const paired = yield* HttpClientRequest.post(`${origin}${HTTP_PATHS.pair}`).pipe(
          HttpClientRequest.schemaBodyJson(PairRequest)({ code: grant.code, name: "Team test" }),
          Effect.flatMap(http.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(PairResult)),
        );
        const protocol = yield* Layer.build(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(
              NodeSocket.layerWebSocket(`ws://127.0.0.1:${status.listener.port}${HTTP_PATHS.rpc}`, {
                headers: { authorization: `Bearer ${paired.token}` },
              }),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        );
        const client = yield* RpcClient.make(J3Rpcs).pipe(Effect.provide(protocol));

        yield* client["engine.subscribe"]().pipe(
          Stream.filter(
            (current) =>
              current.state._tag === "ready" &&
              current.providers.some(
                (provider) => provider.id === "scripted" && provider.status._tag === "ready",
              ),
          ),
          Stream.runHead,
          Effect.flatMap((found) => Effect.fromOption(found)),
          Effect.timeout(ENGINE_READY_WITHIN),
        );

        /** The target's entries, oldest first, once `done` holds for them. */
        const entriesWhen = (
          target: EntryTarget,
          done: (entries: ReadonlyArray<ReceivedEntry>) => boolean,
        ) =>
          client["entries.subscribe"]({ target, after: null }).pipe(
            // Nothing is known of the target until its snapshot.
            Stream.scan(
              (): ReadonlyMap<string, ReceivedEntry> | null => null,
              (held, frame) => {
                const next = new Map(frame._tag === "snapshot" || held === null ? [] : held);
                for (const entry of frame._tag === "snapshot" ? frame.entries : frame.upsert) {
                  next.set(entry.id, entry);
                }
                return next;
              },
            ),
            Stream.filter((held) => held !== null),
            Stream.map((held) => [...held.values()].toSorted((a, b) => a.order - b.order)),
            Stream.filter(done),
            Stream.runHead,
            Effect.flatMap((found) => Effect.fromOption(found)),
            Effect.timeout(TEAM_WITHIN),
          );
        const textOf = (entry: ReceivedEntry | undefined) =>
          entry?._tag === "message" ? entry.text : null;
        const botMessages = (entries: ReadonlyArray<ReceivedEntry>) =>
          entries.flatMap((entry) =>
            entry._tag === "message" && entry.author._tag === "bot"
              ? [[entry.author.botId, entry.text] as const]
              : [],
          );
        const noticeOf = (entry: ReceivedEntry | undefined) =>
          entry?._tag === "notice" ? entry.notice : null;

        // The operator asks their primary bot for a group.
        const scout = yield* client["bot.create"]({
          commandId: CommandId.make("team-primary"),
          name: "Scout",
          primary: true,
        });
        const scoutChat = { _tag: "conversation", botId: scout.id } as const;
        yield* client["message.send"]({
          commandId: CommandId.make("team-ask"),
          target: scoutChat,
          text: "Make me a support group of four bots. [[script:team count=4]]",
          attachments: [],
        });

        // In that turn it made the room, and told the operator so. Its own
        // hello, a turn of the scripted agent's with no directive, says nothing.
        const told = yield* entriesWhen(scoutChat, (entries) =>
          entries.some(
            (entry) =>
              entry._tag === "message" &&
              entry.author._tag === "bot" &&
              (entry.text.startsWith("I started") || entry.text.startsWith("Refused")),
          ),
        );
        const started = told.map(noticeOf).find((notice) => notice?._tag === "room-started");
        assert.deepStrictEqual(
          botMessages(told),
          [[scout.id, "I started Support with the team."]],
          JSON.stringify(told),
        );
        if (started?._tag !== "room-started") return assert.fail("no room-started notice");
        const roomId: RoomId = started.roomId;
        assert.strictEqual(started.botId, scout.id);

        // The members answer in the room, one at a time, in the kickoff's order.
        const room = { _tag: "room", roomId } as const;
        const said = yield* entriesWhen(
          room,
          (entries) => entries.filter((entry) => textOf(entry)?.startsWith("Answer #")).length >= 4,
        );
        const roster = yield* client["roster.subscribe"]().pipe(
          Stream.runHead,
          Effect.flatMap((found) => Effect.fromOption(found)),
        );
        if (roster._tag !== "snapshot") return assert.fail("the roster opened without a snapshot");
        const bots = new Map(
          roster.items.flatMap((item) =>
            item._tag === "bot" ? [[item.bot.profile.name, item.bot.id] as const] : [],
          ),
        );
        const team = TEAM.map((name) => {
          const id = bots.get(name);
          return id ?? assert.fail(`no bot named ${name}`);
        });
        assert.strictEqual(bots.size, 1 + TEAM.length);
        const found = roster.items.flatMap((item): ReadonlyArray<Room> =>
          item._tag === "room" ? [item.room] : [],
        );
        assert.deepStrictEqual(
          found.map(({ name, members, hostId }) => ({ name, members, hostId })),
          [{ name: "Support", members: [scout.id, ...team], hostId: scout.id }],
        );
        const [opened, kickoff, ...answers] = said;
        assert.deepStrictEqual(noticeOf(opened), started);
        assert.deepStrictEqual(
          kickoff?._tag === "message" ? [kickoff.author, kickoff.mentions] : kickoff,
          [
            { _tag: "bot", botId: scout.id },
            { _tag: "bots", ids: team },
          ],
        );
        assert.deepStrictEqual(
          botMessages(answers),
          team.map((botId, index) => [botId, `Answer #${index + 1}.`]),
        );

        // Each made for the room opened there: its own conversation shows
        // only who made it, for which room.
        for (const botId of team) {
          const own = yield* entriesWhen({ _tag: "conversation", botId }, () => true);
          assert.deepStrictEqual(own.map(noticeOf), [
            { _tag: "made-for-room", botId: scout.id, roomId },
          ]);
        }

        // No hello ran: each one's only turn was the room's, after the one before it ended.
        const database = new NodeSqlite.DatabaseSync(path.join(home, HOME_ENTRIES.database), {
          readOnly: true,
        });
        const hellos = decodeStatusRows(
          database
            .prepare(
              `SELECT bot_id, status FROM wakes
               WHERE json_extract(payload_json, '$._tag') = 'first-run' AND bot_id != ?`,
            )
            .all(scout.id),
        );
        const turns = decodeTurnRows(
          database
            .prepare(
              `SELECT sessions.bot_id, audience_room_id, started_at, finished_at
               FROM turns JOIN sessions ON sessions.id = turns.session_id
               WHERE sessions.bot_id != ? ORDER BY started_at`,
            )
            .all(scout.id),
        );
        database.close();
        assert.deepStrictEqual(
          hellos.map((row) => row.status),
          team.map(() => "cancelled"),
        );
        assert.deepStrictEqual(
          turns.map((turn) => [turn.bot_id, turn.audience_room_id]),
          team.map((botId) => [botId, roomId]),
        );
        turns.forEach((turn, index) => {
          const before = turns[index - 1];
          if (before === undefined) return;
          assert.isNotNull(before.finished_at);
          assert.isTrue(turn.started_at >= (before.finished_at ?? ""), JSON.stringify(turns));
        });
      }).pipe(Effect.scoped),
    Duration.toMillis(Duration.minutes(15)),
  );
});
