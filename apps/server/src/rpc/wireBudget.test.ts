// SPDX-License-Identifier: AGPL-3.0-or-later
// The wire budget: what the RPC socket sends a client as it connects to a
// home in long use, and through one ordinary turn, measured in the bytes the
// socket writes, against the budgets below. A change that sends more fails
// here, with every frame it measured; see docs/operations/performance.md.
import { assert, it } from "@effect/vitest";
import {
  Bot,
  type BotId,
  BotState,
  type DeviceId,
  type EntryId,
  EntryPreview,
  J3Rpcs,
  pairBotIds,
  ReceivedEntry,
  RosterItem,
  type WorkFoldEntry,
  type WorkStep,
  WorkStepId,
} from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { CurrentDevice } from "../auth/DeviceAuth.ts";
import { Devices } from "../devices/Devices.ts";
import { Entries, type EntryDraft } from "../entries/Entries.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  eventually,
  command,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { handlers } from "./handlers.ts";

/**
 * The budgets, in bytes of JSON as the socket writes them. Each is what was measured when it was set, and about
 * a tenth more, so a small change passes and a frame resent whole does not.
 */
const BUDGET = {
  /** The conversation's first frame: its newest hundred entries. */
  conversationSnapshot: 55_000,
  /** The roster's first frame: eight bots and two rooms. */
  rosterSnapshot: 10_000,
  /** Everything every subscription sends through the turn. */
  turn: 20_500,
} as const;

type Rpcs = RpcGroup.Rpcs<typeof J3Rpcs>;
type Client = RpcClient.RpcClient<Rpcs>;

/** The RPC of the group with `tag`, typed as that one. */
const rpcNamed = <Tag extends Rpcs["_tag"]>(tag: Tag) => {
  const found = J3Rpcs.requests.get(tag);
  const named = (rpc: Rpcs): rpc is Extract<Rpcs, { readonly _tag: Tag }> => rpc._tag === tag;
  if (found === undefined || !named(found)) throw new Error(`The group has no ${tag}`);
  return found;
};

const utf8 = new TextEncoder();

/** The bytes `value` takes as JSON, encoded with `schema` the way the socket encodes it. */
const jsonBytes =
  <S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  (value: S["Type"]): number =>
    utf8.encode(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(schema))(value))).length;

/**
 * The bytes of the socket frame that carries one value of a stream: the
 * `Chunk` envelope `RpcSerialization.json` writes, around the value as the
 * RPC's success schema encodes it (`RpcServer`'s `encodeChunk`).
 */
const chunkOf =
  <S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  (value: S["Type"]): Chunk => {
    const json = JSON.stringify({
      _tag: "Chunk",
      requestId: "12",
      values: [Schema.encodeSync(Schema.toCodecJson(schema))(value)],
    });
    return { json, bytes: utf8.encode(json).length };
  };

/** A frame as the socket writes it, and its size. */
interface Chunk {
  readonly json: string;
  readonly bytes: number;
}

const entryBytes = jsonBytes(ReceivedEntry);
const rosterItemBytes = jsonBytes(RosterItem);
const botBytes = jsonBytes(Bot);
const stateBytes = jsonBytes(BotState);
const previewBytes = jsonBytes(EntryPreview);

/** One frame a subscription sent: when, its tag, its bytes, and what it carried. */
interface Frame {
  readonly subscription: string;
  readonly phase: "connect" | "turn";
  readonly tag: string;
  readonly bytes: number;
  /** It is byte for byte the frame the subscription sent before it. */
  readonly repeated: boolean;
  readonly detail: string;
}

/** Words for realistic text, chosen by a fixed sequence so every run seeds the same. */
const WORDS = (
  "the build failed on the release branch because the migration ran before the schema " +
  "was published so I rolled it back and opened a pull request with the fix and a test " +
  "that covers the case where a column is renamed while a reader still holds the old name " +
  "deploy staging production review merge check the logs again tomorrow morning thanks"
).split(" ");

const textOf = (seed: number, length: number) => {
  const words: Array<string> = [];
  let size = 0;
  for (let index = 0; size < length; index++) {
    const word = WORDS[(seed * 7 + index * 13) % WORDS.length] ?? "word";
    words.push(word);
    size += word.length + 1;
  }
  return words.join(" ");
};

const message = (botId: BotId, by: "bot" | "operator", text: string): EntryDraft => ({
  _tag: "message",
  author: by === "bot" ? { _tag: "bot", botId } : { _tag: "operator" },
  text,
  attachments: [],
  mentions: { _tag: "bots", ids: [] },
  delivery: { _tag: "delivered" },
  commandId: null,
});

const fold = (botId: BotId, at: DateTime.Utc, steps: number): EntryDraft => ({
  _tag: "work-fold",
  author: { _tag: "bot", botId },
  turnStartedAt: at,
  stepCount: steps,
  apps: [],
  work: null,
  status: { _tag: "finished", finishedAt: at, ending: "completed" },
});

const card = (botId: BotId, seed: number): EntryDraft => ({
  _tag: "question",
  author: { _tag: "bot", botId },
  origin: "ask",
  questions: [
    {
      id: "region",
      prompt: textOf(seed, 120),
      acceptsText: true,
      multiple: false,
      options: [
        {
          id: "option-1",
          label: "Europe",
          description: textOf(seed + 1, 60),
          style: "recommended",
        },
        { id: "option-2", label: "United States", description: null, style: "default" },
        { id: "option-3", label: "Both", description: textOf(seed + 2, 40), style: "default" },
      ],
    },
  ],
  status: { _tag: "answered", answers: { region: { optionIds: ["option-1"], text: null } } },
});

/**
 * A conversation's history as long use leaves it: `turns` turns, each an
 * operator message, the bot's work fold and its reply, and every twentieth
 * turn a card the operator answered.
 */
const seedConversation = (botId: BotId, turns: number) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    const sql = yield* SqlClient.SqlClient;
    const target = { _tag: "conversation", botId } as const;
    const at = yield* DateTime.now;
    const drafts: Array<EntryDraft> = [];
    for (let turn = 0; turn < turns; turn++) {
      drafts.push(message(botId, "operator", textOf(turn, 60 + (turn % 5) * 40)));
      drafts.push(fold(botId, at, 2 + (turn % 9)));
      if (turn % 20 === 19) drafts.push(card(botId, turn));
      drafts.push(message(botId, "bot", textOf(turn + 3, 200 + (turn % 7) * 80)));
    }
    for (let start = 0; start < drafts.length; start += 500) {
      yield* sql.withTransaction(
        Effect.forEach(drafts.slice(start, start + 500), (entry) =>
          entries.append({ target, entry }),
        ),
      );
    }
    return drafts.length;
  });

const pairDevice = Effect.gen(function* () {
  const devices = yield* Devices;
  const { code } = yield* devices.startPairing;
  return (yield* devices.pair({ code, name: "Laptop" })).deviceId;
});

const wallClock = Clock.Clock.defaultValue();
/** Waits in real time: the subscriptions deliver on their own fibers. */
const settle = Effect.sleep("300 millis").pipe(Effect.provideService(Clock.Clock, wallClock));

it.effect(
  "sends a client no more than its budget on connect and through one turn, and nothing twice",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Effect.forEach(
        ["Ana", "Bia", "Caio", "Davi", "Eva", "Fábio", "Gil", "Hugo"],
        (name) => createBot(name),
      );
      const [ana, bia] = bots;
      if (ana === undefined || bia === undefined) return yield* Effect.die("Eight bots");
      const rooms = yield* Rooms;
      const launch = yield* rooms.create({
        commandId: command(),
        name: "Launch",
        members: bots.slice(0, 4).map((bot) => bot.id),
      });
      yield* rooms.create({
        commandId: command(),
        name: "Support",
        members: bots.slice(3).map((bot) => bot.id),
      });
      const seeded = yield* seedConversation(ana.id, 960);
      for (const other of bots.slice(1)) yield* seedConversation(other.id, 8);
      // The room's own talk: the operator and its members, in turn.
      for (let index = 0; index < 60; index++) {
        const speaker = bots[index % 4];
        yield* (yield* Entries).append({
          target: { _tag: "room", roomId: launch.id },
          entry: message(
            speaker?.id ?? ana.id,
            index % 3 === 0 ? "operator" : "bot",
            textOf(index, 120 + (index % 4) * 60),
          ),
        });
      }
      const device: DeviceId = yield* pairDevice;

      const frames: Array<Frame> = [];
      let phase: Frame["phase"] = "connect";
      const follow = <A, E, R>(
        subscription: string,
        stream: Stream.Stream<A, E, R>,
        measure: (value: A) => {
          readonly tag: string;
          readonly chunk: Chunk;
          readonly detail?: string;
        },
      ) => {
        // The frame this subscription sent last, to tell a frame that repeats it.
        let previous = "";
        return stream.pipe(
          Stream.runForEach((value) =>
            Effect.sync(() => {
              const { tag, chunk, detail = "" } = measure(value);
              frames.push({
                subscription,
                phase,
                tag,
                bytes: chunk.bytes,
                repeated: chunk.json === previous,
                detail,
              });
              previous = chunk.json;
            }),
          ),
          Effect.ignore,
          Effect.forkScoped({ startImmediately: true }),
        );
      };

      const roster = rpcNamed("roster.subscribe").successSchema.success;
      const entriesFrame = rpcNamed("entries.subscribe").successSchema.success;
      const steps = rpcNamed("entries.workSteps").successSchema.success;
      const pairs = rpcNamed("pairs.subscribe").successSchema.success;
      const pairMessages = rpcNamed("pairs.messages.subscribe").successSchema.success;
      const routines = rpcNamed("routines.subscribe").successSchema.success;
      const engine = rpcNamed("engine.subscribe").successSchema.success;
      const settings = rpcNamed("settings.subscribe").successSchema.success;
      const notifications = rpcNamed("notifications.subscribe").successSchema.success;
      const browser = rpcNamed("browser.subscribe").successSchema.success;
      const connectors = rpcNamed("connectors.subscribe").successSchema.success;
      const skills = rpcNamed("skills.subscribe").successSchema.success;

      const session = (client: Client) =>
        Effect.gen(function* () {
          const conversation = { _tag: "conversation", botId: ana.id } as const;
          yield* follow("roster.subscribe", client["roster.subscribe"](), (frame) => ({
            tag: frame._tag,
            chunk: chunkOf(roster)(frame),
            detail:
              frame._tag === "changed"
                ? frame.upsert
                    .map((item) =>
                      item._tag === "bot"
                        ? `bot ${item.bot.profile.name} ${rosterItemBytes(item)}B: Bot ${botBytes(item.bot)}B with state ${item.bot.state._tag} ${stateBytes(item.bot.state)}B, lastEntry ${item.lastEntry === null ? 0 : previewBytes(item.lastEntry)}B`
                        : `room ${item.room.name} ${rosterItemBytes(item)}B`,
                    )
                    .join("; ")
                : `${frame.items.length} items`,
          }));
          const measureEntries = (frame: typeof entriesFrame.Type) => ({
            tag: frame._tag,
            chunk: chunkOf(entriesFrame)(frame),
            detail:
              frame._tag === "changed"
                ? frame.upsert
                    .map((entry) =>
                      entry._tag === "work-fold"
                        ? `work-fold(${entry.stepCount} steps, ${entry.status._tag}) ${entryBytes(entry)}B`
                        : entry._tag === "message"
                          ? `message(${entry.delivery._tag}, ${entry.text.length} chars) ${entryBytes(entry)}B`
                          : `${entry._tag} ${entryBytes(entry)}B`,
                    )
                    .join("; ")
                : `${frame.entries.length} entries, hasOlder ${frame.hasOlder}`,
          });
          yield* follow(
            "entries.subscribe (conversation)",
            client["entries.subscribe"]({ target: conversation, after: null }),
            measureEntries,
          );
          yield* follow(
            "entries.subscribe (room)",
            client["entries.subscribe"]({
              target: { _tag: "room", roomId: launch.id },
              after: null,
            }),
            measureEntries,
          );
          yield* follow("pairs.subscribe", client["pairs.subscribe"](), (frame) => ({
            tag: frame._tag,
            chunk: chunkOf(pairs)(frame),
          }));
          yield* follow(
            "pairs.messages.subscribe",
            client["pairs.messages.subscribe"]({ botIds: pairBotIds(ana.id, bia.id) }),
            (frame) => ({ tag: frame._tag, chunk: chunkOf(pairMessages)(frame) }),
          );
          yield* follow(
            "routines.subscribe",
            client["routines.subscribe"]({ botId: ana.id, after: null, withEvents: true }),
            (frame) => ({ tag: frame._tag, chunk: chunkOf(routines)(frame) }),
          );
          yield* follow("engine.subscribe", client["engine.subscribe"](), (status) => ({
            tag: "status",
            chunk: chunkOf(engine)(status),
            detail: `${status.providers.length} providers`,
          }));
          yield* follow("settings.subscribe", client["settings.subscribe"](), (value) => ({
            tag: "settings",
            chunk: chunkOf(settings)(value),
          }));
          yield* follow(
            "notifications.subscribe",
            client["notifications.subscribe"](),
            (value) => ({ tag: "notification", chunk: chunkOf(notifications)(value) }),
          );
          yield* follow(
            "browser.subscribe",
            client["browser.subscribe"]({ botId: ana.id }),
            (value) => ({
              tag: "tabs",
              chunk: chunkOf(browser)(value),
            }),
          );
          yield* follow("connectors.subscribe", client["connectors.subscribe"](), (frame) => ({
            tag: frame._tag,
            chunk: chunkOf(connectors)(frame),
          }));
          yield* follow("skills.subscribe", client["skills.subscribe"](), (value) => ({
            tag: "skills",
            chunk: chunkOf(skills)(value),
            detail: `${value.length} skills`,
          }));

          // Every subscription that starts with its state has sent it.
          const live = ["notifications.subscribe"];
          const opened = 12 - live.length;
          yield* until(
            Effect.sync(() => new Set(frames.map((frame) => frame.subscription)).size >= opened),
          );
          yield* settle;

          // One ordinary turn: the operator writes, the bot works through four
          // steps, then answers with `say`.
          phase = "turn";
          const engineSessionId = yield* engineSession(ana.id);
          yield* sendToBot(
            ana.id,
            "The nightly build failed again. Can you find out why and fix it?",
          );
          const turnId = yield* nextTurn(ana.id);
          const plan: ReadonlyArray<Pick<WorkStep, "kind" | "label">> = [
            { kind: "command", label: "gh run view 4821 --log-failed" },
            { kind: "read", label: "packages/server/src/migrations/0042_rename.ts" },
            { kind: "edit", label: "packages/server/src/migrations/0042_rename.ts" },
            { kind: "command", label: "pnpm test --filter server" },
          ];
          let index = 0;
          let foldId: EntryId | undefined;
          const entries = yield* Entries;
          // The turn's own fold: the conversation's history has finished ones.
          const runningFold = eventually(
            entries
              .latest(conversation, 10)
              .pipe(
                Effect.map((latest) =>
                  Option.fromNullishOr(
                    latest.findLast(
                      (entry): entry is WorkFoldEntry =>
                        entry._tag === "work-fold" && entry.status._tag === "running",
                    ),
                  ),
                ),
              ),
          );
          for (const planned of plan) {
            const startedAt = yield* DateTime.now;
            const running = {
              ...planned,
              id: WorkStepId.make(`step-${++index}`),
              tool: null,
              status: "running",
              startedAt,
              finishedAt: null,
            } as const;
            yield* control.step({ sessionId: engineSessionId, turnId, step: running });
            if (index === 1) {
              // The operator opens the fold as it appears.
              const opened = yield* runningFold;
              foldId = opened.id;
              yield* follow(
                "entries.workSteps",
                client["entries.workSteps"]({ entryId: opened.id }),
                (frame) => ({
                  tag: frame._tag,
                  chunk: chunkOf(steps)(frame),
                  detail:
                    frame._tag === "snapshot" ? `${frame.steps.length} steps` : frame.step.status,
                }),
              );
            }
            yield* settle;
            const finishedAt = yield* DateTime.now;
            yield* control.step({
              sessionId: engineSessionId,
              turnId,
              step: { ...running, status: "completed", finishedAt },
            });
            yield* settle;
          }
          const reply = {
            text: textOf(7, 600),
            done: true,
          };
          yield* control.toolCall({
            sessionId: engineSessionId,
            turnId,
            tool: "say",
            input: reply,
            recorded: "now",
          });
          yield* (yield* BotTools).call({
            requestId: `say-${turnId}`,
            sessionId: engineSessionId,
            tool: "say",
            arguments: reply,
          });
          yield* control.finishTurn({
            sessionId: engineSessionId,
            turnId,
            outcome: { _tag: "completed" },
          });
          yield* turnEnded(ana.id);
          const finished = foldId;
          if (finished === undefined) return yield* Effect.die("The turn has a fold");
          yield* until(
            entries
              .find(finished)
              .pipe(
                Effect.map(
                  (found) =>
                    Option.isSome(found) &&
                    found.value.entry._tag === "work-fold" &&
                    found.value.entry.status._tag === "finished",
                ),
              ),
          );
          yield* settle;
          yield* settle;
        });

      yield* RpcTest.makeClient(J3Rpcs).pipe(
        Effect.flatMap(session),
        Effect.scoped,
        Effect.provide(handlers),
        Effect.provideService(CurrentDevice, { id: device }),
      );

      const text = report(frames, seeded);
      const first = (subscription: string) =>
        frames.find((frame) => frame.subscription === subscription && frame.phase === "connect");
      const conversation = first("entries.subscribe (conversation)");
      assert.strictEqual(conversation?.tag, "snapshot", text);
      assert.isAtMost(conversation?.bytes ?? Infinity, BUDGET.conversationSnapshot, text);
      assert.isAtMost(first("roster.subscribe")?.bytes ?? Infinity, BUDGET.rosterSnapshot, text);
      const turn = frames.filter((frame) => frame.phase === "turn");
      assert.isNotEmpty(turn, text);
      assert.isAtMost(
        turn.reduce((sum, frame) => sum + frame.bytes, 0),
        BUDGET.turn,
        text,
      );
      assert.deepStrictEqual(
        turn.filter((frame) => frame.repeated).map((frame) => frame.subscription),
        [],
        text,
      );
    }).pipe(Effect.provide(TestDomain.layer)),
  { timeout: 300_000 },
);

/** Each subscription's first frame, then every frame of the turn, and the turn's totals. */
const report = (frames: ReadonlyArray<Frame>, seeded: number): string => {
  const lines: Array<string> = [`Seeded conversation: ${seeded} entries`, "", "On connect:"];
  const seen = new Set<string>();
  for (const frame of frames) {
    if (frame.phase !== "connect" || seen.has(frame.subscription)) continue;
    seen.add(frame.subscription);
    lines.push(`  ${frame.subscription} ${frame.tag}: ${frame.bytes} B  ${frame.detail}`);
  }
  lines.push("", "During the turn:");
  const totals = new Map<string, { count: number; bytes: number }>();
  for (const frame of frames) {
    if (frame.phase !== "turn") continue;
    const repeated = frame.repeated ? "[repeats the previous] " : "";
    lines.push(
      `  ${frame.subscription} ${frame.tag}: ${frame.bytes} B  ${repeated}${frame.detail}`,
    );
    const key = `${frame.subscription} ${frame.tag}`;
    const total = totals.get(key) ?? { count: 0, bytes: 0 };
    totals.set(key, { count: total.count + 1, bytes: total.bytes + frame.bytes });
  }
  lines.push("", "Turn totals:");
  for (const [key, total] of totals) {
    lines.push(`  ${key}: ${total.count} frames, ${total.bytes} B`);
  }
  return lines.join("\n");
};
