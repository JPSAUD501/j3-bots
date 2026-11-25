// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The reads eval: the real server and engine, a room of four bots on one
 * harness, and an operator who writes two messages: a greeting that names
 * nobody, which wakes every member, then one that asks a single member to
 * say one word and everyone else to keep quiet. Each is followed until the
 * room is quiet, counting its turns. Run several times and scored from the
 * database. See `evals/README.md`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type BotId,
  CommandId,
  type Mentions,
  ModelId,
  type RoomId,
  SignInHarness,
  signInHarnesses,
} from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { busy, roomActivity } from "./score.ts";
import {
  type Client,
  connectClient,
  connectProviders,
  EvalFailure,
  keepEngine,
  logTail,
  pair,
  readyProvider,
  removeHome,
  type ServerSpec,
  startServer,
} from "./server.ts";

/** What the operator is called, so no bot's hello asks for it. */
const OPERATOR = "Marina";

/** The room, in member order. */
const TEAM = [
  {
    name: "Cy",
    title: "Developer",
    job: "Builds and runs the shop's website, and fixes its code.",
  },
  {
    name: "Ana",
    title: "Finance",
    job: "Keeps the shop's books: prices, fees, margins and taxes, worked out with the numbers.",
  },
  {
    name: "Bo",
    title: "Designer",
    job: "Designs the shop's logo, product photos and pages.",
  },
  {
    name: "Dee",
    title: "Support",
    job: "Answers the shop's customers by email and keeps the help pages current.",
  },
] as const;

const GREETING = "Hi everyone!";

/**
 * At most this many turns between the greeting and a quiet room: it wakes
 * every member, and each may read the replies to it once more. Past it, a
 * reply set the members off answering each other.
 */
const GREETING_TURNS = 2 * TEAM.length;

/** The member the second message asks for one word. */
const ASKED = "Ana";

const WORD_REQUEST = `@${ASKED} send only 'banana'; everyone else don't answer`;

/** The asked member's whole reply: the word, at most quoted or with a full stop. */
const WORD = /^\W*banana\W*$/i;

/**
 * At most this many turns between the word request and a quiet room: it
 * wakes only the member it names, whose reply names nobody, so it wakes
 * every other member once, and they have nothing to say to it.
 */
const WORD_TURNS = TEAM.length;

/** How long one run may take, from boot to the last quiet room, before it counts as stuck. */
const RUN_DEADLINE = Duration.minutes(20);

/** How long nothing may be under way before the room counts as quiet. */
const QUIET_FOR = Duration.seconds(30);

/** How many of the server's last log lines a failed run reports. */
const LOG_LINES = 20;

interface Endpoint {
  readonly baseUrl: string;
  readonly key: Redacted.Redacted<string>;
}

const command = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return CommandId.make(Base64Url.encode(yield* random.randomBytes(16)));
});

/** Waits until nothing has been under way for `QUIET_FOR`. */
const quiet = Effect.fn("quiet")(function* (database: string) {
  let since = Option.none<DateTime.Utc>();
  while (true) {
    const now = yield* DateTime.now;
    if (yield* busy(database)) since = Option.none();
    else if (Option.isNone(since)) since = Option.some(now);
    else if (Duration.isGreaterThanOrEqualTo(DateTime.distance(since.value, now), QUIET_FOR)) {
      return;
    }
    yield* Effect.sleep("2 seconds");
  }
});

/** What the members did with one message of the operator's, until the room was quiet. */
interface Step {
  readonly turns: number;
  /** The members' messages, in order, each with its author's name. */
  readonly replies: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  readonly chainStopped: number;
}

/** The operator writes `text` in the room, mentioning `mentions`; the room then goes quiet. */
const writeToRoom = Effect.fn("writeToRoom")(function* (
  client: Client,
  database: string,
  roomId: RoomId,
  names: ReadonlyMap<BotId, string>,
  text: string,
  mentions: Mentions,
) {
  const before = yield* roomActivity(database, roomId);
  yield* client["message.send"]({
    commandId: yield* command,
    target: { _tag: "room", roomId },
    text,
    attachments: [],
    mentions,
  });
  yield* quiet(database);
  const after = yield* roomActivity(database, roomId);
  return {
    turns: after.turns - before.turns,
    replies: after.messages
      .slice(before.messages.length)
      .flatMap((message) =>
        message.author === null
          ? []
          : [{ name: names.get(message.author) ?? message.author, text: message.text }],
      ),
    chainStopped: after.chainStopped - before.chainStopped,
  } satisfies Step;
});

/** One run in a fresh home, from boot to score. */
const runOnce = Effect.fn("runOnce")(function* (
  spec: ServerSpec,
  log: string,
  endpoint: Endpoint,
  harness: SignInHarness,
  model: Option.Option<string>,
) {
  const path = yield* Path.Path;
  const database = path.join(spec.home, "j3.sqlite");
  yield* startServer(spec, log);
  yield* connectProviders(spec, endpoint);
  const { token } = yield* pair(spec, "Reads eval");
  const client = yield* connectClient(spec, token);
  const provider = yield* readyProvider(client, harness);
  const listed = provider.models.map((one) => one.id);
  const chosen = Option.getOrElse(model, () => listed[0] ?? "");
  if (!listed.some((id) => id === chosen)) {
    return yield* new EvalFailure({
      reason: `${signInHarnesses[harness].name} has no model ${chosen}; it lists ${listed.join(", ")}`,
    });
  }
  const modelId = ModelId.make(chosen);
  yield* client["settings.update"]({ commandId: yield* command, operatorName: OPERATOR });
  const bots = yield* Effect.forEach(TEAM, (member) =>
    Effect.flatMap(command, (commandId) =>
      client["bot.create"]({
        commandId,
        name: member.name,
        title: member.title,
        job: member.job,
        model: { providerId: provider.id, modelId },
        permissionMode: "auto",
      }),
    ),
  );
  yield* quiet(database);
  const room = yield* client["room.create"]({
    commandId: yield* command,
    name: "Shop",
    members: bots.map((bot) => bot.id),
  });
  const names = new Map<BotId, string>(bots.map((bot) => [bot.id, bot.profile.name]));
  const asked = bots.find((bot) => bot.profile.name === ASKED);
  if (asked === undefined) return yield* new EvalFailure({ reason: `${ASKED} was not created` });

  const started = yield* DateTime.now;
  const greeting = yield* writeToRoom(client, database, room.id, names, GREETING, {
    _tag: "bots",
    ids: [],
  });
  const word = yield* writeToRoom(client, database, room.id, names, WORD_REQUEST, {
    _tag: "bots",
    ids: [asked.id],
  });
  const minutes = Duration.toMinutes(DateTime.distance(started, yield* DateTime.now));
  return { _tag: "scored" as const, minutes, modelId, greeting, word };
}, Effect.scoped);

type Run = Effect.Success<ReturnType<typeof runOnce>>;

/** A run that ended before it could be scored, with what its server wrote last. */
interface Broken {
  readonly _tag: "broken";
  readonly reason: string;
  readonly log: ReadonlyArray<string>;
}

/** What went on too long after one message: more turns than `budget`, or a room gone quiet. */
const looped = (step: Step, budget: number): ReadonlyArray<string> => [
  ...(step.turns <= budget ? [] : [`${step.turns} turns`]),
  ...(step.chainStopped === 0 ? [] : ["room went quiet"]),
];

/**
 * The greeting's failed conditions: someone greets back, and the room
 * settles on its own. How many greet back is shown, not scored: each member
 * may.
 */
const greetingFailures = (step: Step): ReadonlyArray<string> => [
  ...(step.replies.length > 0 ? [] : ["nobody answered"]),
  ...looped(step, GREETING_TURNS),
];

/**
 * The word request's failed conditions: its member says the word and nothing
 * else, nobody else speaks, and the room settles.
 */
const wordFailures = (step: Step): ReadonlyArray<string> => {
  const answers = step.replies.filter((reply) => reply.name === ASKED);
  const others = step.replies.filter((reply) => reply.name !== ASKED);
  return [
    ...(answers.length === 1 && answers.every((reply) => WORD.test(reply.text))
      ? []
      : [`${ASKED} said ${answers.length === 0 ? "nothing" : "more than the word"}`]),
    ...(others.length === 0 ? [] : [`${others.map((reply) => reply.name).join(", ")} spoke`]),
    ...looped(step, WORD_TURNS),
  ];
};

const failures = (run: Run) => [...greetingFailures(run.greeting), ...wordFailures(run.word)];

const passed = (outcome: Run | Broken) =>
  outcome._tag === "scored" && failures(outcome).length === 0;

/** Text for a table cell: one line, no pipes, cut to `length`. */
const cell = (text: string, length: number) => {
  const line = text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** Who said what after one message, in order. */
const said = (step: Step) =>
  cell(step.replies.map((reply) => `${reply.name}: ${reply.text}`).join(" / "), 240);

const HEADER = [
  "| Run | Greeting | Replies | Turns | Banana | Replies | Turns | Minutes | Said to the greeting | Said to the banana request |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

const verdict = (failed: ReadonlyArray<string>) =>
  failed.length === 0 ? "pass" : `fail (${failed.join("; ")})`;

const row = (index: number, outcome: Run | Broken) => {
  if (outcome._tag === "broken") {
    return `| ${index} | error: ${cell(outcome.reason, 200)} | | | | | | | | |`;
  }
  const { greeting, word } = outcome;
  const cells = [
    index,
    verdict(greetingFailures(greeting)),
    greeting.replies.length,
    greeting.turns,
    verdict(wordFailures(word)),
    word.replies.length,
    word.turns,
    outcome.minutes.toFixed(1),
    said(greeting),
    said(word),
  ];
  return `| ${cells.join(" | ")} |`;
};

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const endpoint: Endpoint = {
    baseUrl: yield* Config.String("J3_EVAL_BASE_URL"),
    key: yield* Config.Redacted("J3_EVAL_API_KEY"),
  };
  const harness = yield* Config.schema(SignInHarness, "J3_EVAL_HARNESS");
  const runs = yield* Config.Int("J3_EVAL_RUNS").pipe(Config.withDefault(10));
  const port = yield* Config.Port("J3_EVAL_PORT").pipe(Config.withDefault(3881));
  const model = yield* Config.option(Config.String("J3_EVAL_MODEL"));
  const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const repo = path.resolve(here, "..", "..");

  // Every run's home and log, and with them the stored connection, are gone when the eval ends.
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-evals-reads-" });
  let engineBinary = Option.none<string>();
  const outcomes: Array<Run | Broken> = [];
  for (let index = 1; index <= runs; index++) {
    const home = path.join(root, `run-${index}`);
    const log = `${home}.log`;
    const spec: ServerSpec = {
      repo,
      home,
      port,
      engineBinary,
    };
    yield* Console.log(`Run ${index} of ${runs} on ${signInHarnesses[harness].name}`);
    const outcome: Run | Broken = yield* runOnce(spec, log, endpoint, harness, model).pipe(
      Effect.timeoutOrElse({
        duration: RUN_DEADLINE,
        orElse: () =>
          Effect.fail(
            new EvalFailure({ reason: `not done within ${Duration.format(RUN_DEADLINE)}` }),
          ),
      }),
      Effect.catch((failure) =>
        Effect.map(logTail(log, LOG_LINES), (lines): Broken => ({
          _tag: "broken",
          reason: failure.message,
          log: lines,
        })),
      ),
    );
    if (outcome._tag === "broken") {
      yield* Console.log(
        [`  error: ${outcome.reason}`, "  the server's last lines:", ...outcome.log].join("\n"),
      );
    }
    // The first run's engine serves the rest; each run's home, key included, goes now.
    if (Option.isNone(engineBinary)) {
      engineBinary = yield* keepEngine(home, path.join(root, "engine"));
    }
    yield* removeHome(home);
    yield* Console.log(row(index, outcome));
    outcomes.push(outcome);
  }
  const scored = outcomes.flatMap((outcome) => (outcome._tag === "scored" ? [outcome] : []));
  const ranOn = scored[0]?.modelId;
  const count = (ok: (run: Run) => boolean) => scored.filter(ok).length;
  yield* Console.log(
    [
      "",
      `${signInHarnesses[harness].name}${ranOn === undefined ? "" : ` (${ranOn})`}: ${outcomes.filter(passed).length} of ${runs} passed`,
      `  greeting ${count((run) => greetingFailures(run.greeting).length === 0)}, banana ${count((run) => wordFailures(run.word).length === 0)}, no loop ${count((run) => looped(run.greeting, GREETING_TURNS).length === 0 && looped(run.word, WORD_TURNS).length === 0)}`,
      "",
      ...HEADER,
      ...outcomes.map((outcome, i) => row(i + 1, outcome)),
    ].join("\n"),
  );
  const failed = outcomes.filter((outcome) => !passed(outcome)).length;
  if (failed > 0) {
    return yield* new EvalFailure({ reason: `${failed} of ${runs} runs failed` });
  }
}).pipe(Effect.scoped);

main.pipe(
  Effect.provide(
    Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, SecureRandom.layerWebCrypto),
  ),
  NodeRuntime.runMain,
);
