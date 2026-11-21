// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The three-bot room eval: the real server and engine, three Claude Code bots
 * and one multi-step task, run several times and scored from the database.
 * See `evals/README.md`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type BotId, CommandId, ModelId } from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { busy, type Score, score } from "./score.ts";
import {
  claudeCode,
  type Client,
  connectClient,
  connectProviders,
  EvalFailure,
  type ServerSpec,
  startServer,
} from "./server.ts";

/** The file the task asks for, which the writer shares in the room. */
const OUTPUT = "release-notes.md";

/** At most this many bot turns for the task: host, researcher, writer, host, and room for one check-back. */
const TURN_BUDGET = 6;

const TEAM = [
  {
    name: "Hal",
    title: "Team lead",
    job: "Leads the team: takes the operator's requests, decides which teammate does each part, and checks the result before it goes back to the operator.",
  },
  {
    name: "Ana",
    title: "Researcher",
    job: "Analyses data and user feedback, and reports what it shows with the numbers behind it.",
  },
  {
    name: "Bo",
    title: "Writer",
    job: "Writes release notes, announcements and other documents, as files.",
  },
] as const;

/** Fictional beta feedback for a fictional app. */
const FEEDBACK = [
  "1. Please let me export my budget to CSV.",
  "2. Dark mode would make evening check-ins easier.",
  "3. I want to split one purchase across two categories.",
  "4. CSV export, so my accountant can read it.",
  "5. Recurring transactions are missing.",
  "6. Dark mode, please.",
  "7. Let me export to CSV or a spreadsheet.",
  "8. Splitting a receipt between categories would help a lot.",
  "9. I'd love a dark theme.",
  "10. Export to CSV!",
  "11. Can I set up a recurring rent payment?",
  "12. The new monthly summary screen is great.",
].join("\n");

const TASK = [
  "We ship version 2.4 of Tally, our budgeting app, next week. It adds the monthly summary screen and faster sync.",
  "Here is the feedback from the beta:",
  "",
  FEEDBACK,
  "",
  `I need a file named ${OUTPUT} with a short "What's new" section for 2.4 and a "Most requested next" section listing the three features beta users asked for most, with how many asked for each. Ana counts the requests, Bo writes the file from her numbers, and Hal checks it before it comes back to me. Share the file here when it is done.`,
].join("\n");

/** How long a run may take before it counts as stuck. */
const RUN_DEADLINE = Duration.minutes(20);

/** How long nothing may be under way before the room counts as finished. */
const QUIET_FOR = Duration.seconds(30);

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

/** Creates the team on the model and waits until their first-run turns are over. */
const createTeam = Effect.fn("createTeam")(function* (
  client: Client,
  database: string,
  model: Option.Option<string>,
) {
  const provider = yield* claudeCode(client);
  const listed = provider.models.map((one) => one.id);
  const chosen = Option.getOrElse(model, () => listed[0] ?? "");
  if (!listed.some((id) => id === chosen)) {
    return yield* new EvalFailure({
      reason: `Claude Code has no model ${chosen}; it lists ${listed.join(", ")}`,
    });
  }
  const modelId = ModelId.make(chosen);
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
  return { bots, modelId };
});

/** One run in a fresh home, from boot to score. */
const runOnce = Effect.fn("runOnce")(function* (
  spec: ServerSpec,
  endpoint: Endpoint,
  model: Option.Option<string>,
) {
  const path = yield* Path.Path;
  const database = path.join(spec.home, "j3.sqlite");
  yield* startServer(spec, `${spec.home}.log`);
  yield* connectProviders(spec, endpoint);
  const client = yield* connectClient(spec);
  const { bots, modelId } = yield* createTeam(client, database, model);
  yield* Console.log(`  ${bots.length} bots on ${modelId}; the task goes to the room`);
  const [host, ...others] = bots;
  if (host === undefined) return yield* new EvalFailure({ reason: "No bot was created" });
  const room = yield* client["room.create"]({
    commandId: yield* command,
    name: "Release",
    members: [host.id, ...others.map((bot) => bot.id)],
    hostId: host.id,
  });

  const started = yield* DateTime.now;
  yield* client["message.send"]({
    commandId: yield* command,
    target: { _tag: "room", roomId: room.id },
    text: TASK,
    attachments: [],
    mentions: { _tag: "bots", ids: [] },
  });
  const finished = yield* quiet(database).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({ duration: RUN_DEADLINE, orElse: () => Effect.succeed(false) }),
  );
  const minutes = Duration.toMinutes(DateTime.distance(started, yield* DateTime.now));
  const names = new Map<BotId, string>(bots.map((bot) => [bot.id, bot.profile.name]));
  return {
    finished,
    minutes,
    modelId,
    hopLimit: room.hopLimit,
    score: yield* score(database, room.id, names),
  };
}, Effect.scoped);

type Run = Effect.Success<ReturnType<typeof runOnce>>;

/** The pass conditions, each failed one named. */
const failures = (run: Run): ReadonlyArray<string> => {
  const { score: s } = run;
  return [
    ...(run.finished ? [] : ["did not finish"]),
    ...(s.files.includes(OUTPUT) ? [] : [`no ${OUTPUT}`]),
    ...(s.botTurns <= TURN_BUDGET ? [] : [`${s.botTurns} bot turns`]),
    ...(s.unaddressedTurns === 0 ? [] : [`${s.unaddressedTurns} unaddressed turns`]),
    ...(s.chainStopped === 0 ? [] : ["chain stopped"]),
    ...(s.offAddressSays === 0 ? [] : [`${s.offAddressSays} says off address`]),
  ];
};

const HEADER = [
  "| Run | Result | File | Bot turns | Turns | Unaddressed turns | Chain stopped | Off-address says | Hops / limit | Minutes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

const isFailure = Schema.is(EvalFailure);

const row = (index: number, outcome: Run | EvalFailure) => {
  if (isFailure(outcome)) {
    return `| ${index} | error: ${outcome.reason} | | | | | | | | |`;
  }
  const s: Score = outcome.score;
  const failed = failures(outcome);
  const cells = [
    index,
    failed.length === 0 ? "pass" : `fail (${failed.join("; ")})`,
    s.files.includes(OUTPUT) ? "yes" : "no",
    s.botTurns,
    s.sequence.join(" → "),
    s.unaddressedTurns,
    s.chainStopped,
    s.offAddressSays,
    `${s.maxHops} / ${outcome.hopLimit}`,
    outcome.minutes.toFixed(1),
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
  const runs = yield* Config.Int("J3_EVAL_RUNS").pipe(Config.withDefault(5));
  const port = yield* Config.Port("J3_EVAL_PORT").pipe(Config.withDefault(3861));
  const model = yield* Config.option(Config.String("J3_EVAL_MODEL"));
  const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const repo = path.resolve(here, "..", "..");

  // Every run's home, and with it the stored connection, is gone when the eval ends.
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-evals-room-" });
  const engineDir = path.join(root, "engine");
  const lines: Array<string> = [];
  for (let index = 1; index <= runs; index++) {
    const home = path.join(root, `run-${index}`);
    const installed = yield* fs.exists(engineDir);
    const spec: ServerSpec = {
      repo,
      home,
      port,
      engineBinary: installed ? Option.some(path.join(engineDir, "t3")) : Option.none(),
    };
    yield* Console.log(`Run ${index} of ${runs}`);
    const outcome = yield* runOnce(spec, endpoint, model).pipe(
      Effect.catchTag("EvalFailure", Effect.succeed),
    );
    // The first run's engine serves the rest; each run's home, key included, goes now.
    if (!installed) {
      const runtime = path.join(home, "engine", "j3", "runtime");
      const [version] = yield* fs
        .readDirectory(runtime)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      if (version !== undefined) yield* fs.rename(path.join(runtime, version), engineDir);
    }
    yield* fs.remove(home, { recursive: true });
    const line = row(index, outcome);
    yield* Console.log(line);
    lines.push(line);
  }
  yield* Console.log(["", ...HEADER, ...lines].join("\n"));
}).pipe(Effect.scoped);

main.pipe(
  Effect.provide(
    Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, SecureRandom.layerWebCrypto),
  ),
  NodeRuntime.runMain,
);
