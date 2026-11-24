// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The team eval: the real server and engine, one primary bot on one harness,
 * and an operator who asks it, in Portuguese, for a support group of bots.
 * Run several times and scored from the database. See `evals/README.md`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ModelId, SignInHarness, signInHarnesses } from "@j3-bots/contracts";
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
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { busy, scoreTeam, type TeamScore } from "./score.ts";
import {
  connectClient,
  connectProviders,
  EvalFailure,
  logTail,
  pair,
  readyProvider,
  removeHome,
  type ServerSpec,
  startServer,
} from "./server.ts";

/** What the operator is called, so the primary bot's hello asks nothing. */
const OPERATOR = "Marina";

const PRIMARY = "Lia";

/**
 * The request, as an operator would write it: a group of several bots and
 * what it is for. Who is in it, and what each does, is the bot's to decide.
 */
const ASK =
  "Oi, Lia! Quero um grupo de suporte com vários bots para me ajudar a abrir a loja online da minha confeitaria. Pode montar isso para mim?";

/** At least this many bots made: "several". */
const MIN_MADE = 2;

/** How long one run may take, from boot to a member's answer, before it counts as stuck. */
const RUN_DEADLINE = Duration.minutes(20);

/** How long nothing may be under way before a run counts as finished. */
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

/**
 * Waits until nothing has been under way for `QUIET_FOR`, or, with `enough`,
 * until it holds: a run is over once a member has answered in the room,
 * whatever work the team then goes on with.
 */
const settled = Effect.fn("settled")(function* (
  database: string,
  enough: Effect.Effect<boolean> = Effect.succeed(false),
) {
  let since = Option.none<DateTime.Utc>();
  while (true) {
    if (yield* enough) return;
    const now = yield* DateTime.now;
    if (yield* busy(database)) since = Option.none();
    else if (Option.isNone(since)) since = Option.some(now);
    else if (Duration.isGreaterThanOrEqualTo(DateTime.distance(since.value, now), QUIET_FOR)) {
      return;
    }
    yield* Effect.sleep("2 seconds");
  }
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
  const { token } = yield* pair(spec, "Team eval");
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
  const primary = yield* client["bot.create"]({
    commandId: yield* command,
    name: PRIMARY,
    primary: true,
    model: { providerId: provider.id, modelId },
    permissionMode: "auto",
  });
  yield* settled(database);

  const started = yield* DateTime.now;
  yield* client["message.send"]({
    commandId: yield* command,
    target: { _tag: "conversation", botId: primary.id },
    text: ASK,
    attachments: [],
  });
  const answered = scoreTeam(database, primary.id).pipe(
    Effect.map((score) => score.answered.length > 0),
  );
  yield* settled(database, answered);
  const minutes = Duration.toMinutes(DateTime.distance(started, yield* DateTime.now));
  return {
    _tag: "scored" as const,
    minutes,
    modelId,
    primary: primary.id,
    score: yield* scoreTeam(database, primary.id),
  };
}, Effect.scoped);

type Run = Effect.Success<ReturnType<typeof runOnce>>;

/** A run that ended before it could be scored, with what its server wrote last. */
interface Broken {
  readonly _tag: "broken";
  readonly reason: string;
  readonly log: ReadonlyArray<string>;
}

/** The pass conditions, each failed one named. */
const failures = (run: Run): ReadonlyArray<string> => {
  const s: TeamScore = run.score;
  return [
    ...(s.made.length >= MIN_MADE ? [] : [`${s.made.length} bots made`]),
    ...Option.match(s.room, {
      onNone: () => ["no room"],
      onSome: (room) => [
        ...(room.members[0] === run.primary ? [] : [`${PRIMARY} not its first member`]),
        ...(s.made.every((id) => room.members.includes(id)) ? [] : ["a made bot left out"]),
        ...(s.kickoffs > 0 ? [] : ["no kickoff"]),
        ...(s.answered.length > 0 ? [] : ["no member answered"]),
      ],
    }),
  ];
};

const HEADER = [
  "| Run | Result | Made | Made on | Room members | Kickoff | Answered | Member wakes | Member tools | Hellos | Tools | Told the operator | Minutes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

const passed = (outcome: Run | Broken) =>
  outcome._tag === "scored" && failures(outcome).length === 0;

/** Each distinct value with how often it occurs, in order of first occurrence: `codex ×3`. */
const tally = (values: ReadonlyArray<string>) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => `${value} ×${count}`).join(", ");
};

/** Text for a table cell: one line, no pipes, cut to `length`. */
const cell = (text: string, length: number) => {
  const line = text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

const row = (index: number, outcome: Run | Broken) => {
  if (outcome._tag === "broken") {
    return `| ${index} | error: ${cell(outcome.reason, 200)} | | | | | | | | | | | |`;
  }
  const s = outcome.score;
  const failed = failures(outcome);
  const cells = [
    index,
    failed.length === 0 ? "pass" : `fail (${failed.join("; ")})`,
    s.made.length,
    tally(s.madeOn),
    Option.match(s.room, { onNone: () => "", onSome: (room) => room.members.length }),
    s.kickoffs > 0 ? "yes" : "no",
    s.answered.length,
    cell(s.memberWakes.join(", "), 80),
    cell(s.memberTools.join(", "), 80),
    s.hellos,
    cell(s.tools.join(", "), 160),
    cell(
      Option.getOrElse(s.told, () => ""),
      160,
    ),
    outcome.minutes.toFixed(1),
  ];
  return `| ${cells.join(" | ")} |`;
};

const EnginePin = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const endpoint: Endpoint = {
    baseUrl: yield* Config.String("J3_EVAL_BASE_URL"),
    key: yield* Config.Redacted("J3_EVAL_API_KEY"),
  };
  const harness = yield* Config.schema(SignInHarness, "J3_EVAL_HARNESS");
  const runs = yield* Config.Int("J3_EVAL_RUNS").pipe(Config.withDefault(3));
  const port = yield* Config.Port("J3_EVAL_PORT").pipe(Config.withDefault(3871));
  const model = yield* Config.option(Config.String("J3_EVAL_MODEL"));
  const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const repo = path.resolve(here, "..", "..");
  const { version } = yield* fs
    .readFileString(path.join(repo, "engine.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(EnginePin)));

  // Every run's home and log, and with them the stored connection, are gone when the eval ends.
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-evals-team-" });
  const engineDir = path.join(root, "engine");
  const engineBinary = path.join(engineDir, "t3");
  const outcomes: Array<Run | Broken> = [];
  for (let index = 1; index <= runs; index++) {
    const home = path.join(root, `run-${index}`);
    const log = `${home}.log`;
    const installed = yield* fs.exists(engineBinary);
    const spec: ServerSpec = {
      repo,
      home,
      port,
      engineBinary: installed ? Option.some(engineBinary) : Option.none(),
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
    if (!installed) {
      const fresh = path.join(home, "engine", "j3", "runtime", version);
      if (yield* fs.exists(path.join(fresh, "t3"))) yield* fs.rename(fresh, engineDir);
    }
    yield* removeHome(home);
    yield* Console.log(row(index, outcome));
    outcomes.push(outcome);
  }
  const ranOn = outcomes.find((outcome) => outcome._tag === "scored")?.modelId;
  yield* Console.log(
    [
      "",
      `${signInHarnesses[harness].name}${ranOn === undefined ? "" : ` (${ranOn})`}: ${outcomes.filter(passed).length} of ${runs} passed`,
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
