// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The three-bot room eval: the real server and engine, three Claude Code bots
 * and a bystander, one multi-step task, run several times and scored from the
 * database. See `evals/README.md`.
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
  download,
  EvalFailure,
  logTail,
  pair,
  type ServerSpec,
  startServer,
} from "./server.ts";

/** The file the task asks for, which the writer shares in the room. */
const OUTPUT = "release-notes.md";

/**
 * At most this many bot turns for the task. Its handoffs take four (host,
 * researcher, writer, host); six leaves the host one round of sending the
 * file back to the writer for a fix, which is the host's job. A bot woken with
 * nothing to do is caught by the bystander's wakes, not by this budget.
 */
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
  {
    name: "Cy",
    title: "Designer",
    job: "Designs the app's screens, icons and illustrations.",
  },
] as const;

/** The member the task gives no part: any room wake of theirs is a wake with nothing to do. */
const BYSTANDER = "Cy";

/** Fictional beta feedback for a fictional app: requests of four, three, two and one. */
const FEEDBACK = [
  "1. Please let me export my budget to CSV.",
  "2. Dark mode would make evening check-ins easier.",
  "3. I want to split one purchase across two categories.",
  "4. CSV export, so my accountant can read it.",
  "5. Recurring transactions are missing.",
  "6. Dark mode, please.",
  "7. Let me export to CSV or a spreadsheet.",
  "8. Sync feels much faster than in 2.3.",
  "9. I'd love a dark theme.",
  "10. Export to CSV!",
  "11. Can I set up a recurring rent payment?",
  "12. The new monthly summary screen is great.",
].join("\n");

/** The three features `FEEDBACK` asks for most, how to recognize each in a line, and its count. */
const MOST_REQUESTED = [
  { feature: "CSV export", mention: /csv/i, count: /\b(?:4|four)\b/i },
  { feature: "dark mode", mention: /dark/i, count: /\b(?:3|three)\b/i },
  { feature: "recurring transactions", mention: /recurring/i, count: /\b(?:2|two)\b/i },
] as const;

/** Asked for once: on the list, it would be a fourth. */
const RUNNER_UP = { feature: "splitting a purchase", mention: /split/i } as const;

const TASK = [
  "We ship version 2.4 of Tally, our budgeting app, next week. It adds the monthly summary screen and faster sync.",
  "Here is the feedback from the beta:",
  "",
  FEEDBACK,
  "",
  `I need a file named ${OUTPUT} with a short "What's new" section for 2.4 and a "Most requested next" section listing the three features beta users asked for most, with how many asked for each. Ana counts the requests, Bo writes the file from her numbers, and Hal checks it before it comes back to me. Share the file here when it is done.`,
].join("\n");

/** How long one run may take, from boot to a quiet room, before it counts as stuck. */
const RUN_DEADLINE = Duration.minutes(30);

/** How long nothing may be under way before the room counts as finished. */
const QUIET_FOR = Duration.seconds(30);

/** How many of the server's last log lines a failed run reports. */
const LOG_LINES = 20;

interface Endpoint {
  readonly baseUrl: string;
  readonly key: Redacted.Redacted<string>;
}

const HEADING = /^#{1,6}\s/;

/** A list item's text without its marker, so a "2." numbering an item is never read as its count. */
const itemText = (line: string) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");

/**
 * What is wrong with the shared file's "Most requested next" section: each of
 * the three features must be on a line with its count, and the fourth must
 * not be listed. Empty when it is right.
 */
const contentProblems = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => HEADING.test(line) && /most requested/i.test(line));
  if (start === -1) return ["no Most requested section"];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => HEADING.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).map(itemText);
  return [
    ...MOST_REQUESTED.flatMap(({ feature, mention, count }) => {
      const mentioned = section.filter((line) => mention.test(line));
      if (mentioned.length === 0) return [`misses ${feature}`];
      return mentioned.some((line) => count.test(line)) ? [] : [`wrong count for ${feature}`];
    }),
    ...(section.some((line) => RUNNER_UP.mention.test(line)) ? [`lists ${RUNNER_UP.feature}`] : []),
  ];
};

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
  log: string,
  endpoint: Endpoint,
  model: Option.Option<string>,
) {
  const path = yield* Path.Path;
  const database = path.join(spec.home, "j3.sqlite");
  yield* startServer(spec, log);
  yield* connectProviders(spec, endpoint);
  const { token } = yield* pair(spec);
  const client = yield* connectClient(spec, token);
  const { bots, modelId } = yield* createTeam(client, database, model);
  yield* Console.log(`  ${bots.length} bots on ${modelId}; the task goes to the room`);
  const [host, ...others] = bots;
  const bystander = bots.find((bot) => bot.profile.name === BYSTANDER);
  if (host === undefined || bystander === undefined) {
    return yield* new EvalFailure({ reason: "The team was not created" });
  }
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
  yield* quiet(database);
  const minutes = Duration.toMinutes(DateTime.distance(started, yield* DateTime.now));
  const names = new Map<BotId, string>(bots.map((bot) => [bot.id, bot.profile.name]));
  const scored = yield* score(database, room.id, names, bystander.id);
  // The last one, in case the host shared the file again after a fix.
  const shared = scored.files.findLast((file) => file.name === OUTPUT);
  const content =
    shared === undefined
      ? Option.none()
      : Option.some(contentProblems(yield* download(spec, token, shared.id)));
  return {
    _tag: "scored" as const,
    minutes,
    modelId,
    hopLimit: room.hopLimit,
    score: scored,
    content,
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
  const { score: s } = run;
  return [
    ...Option.match(run.content, {
      onNone: () => [`no ${OUTPUT}`],
      onSome: (problems) => problems,
    }),
    ...(s.botTurns <= TURN_BUDGET ? [] : [`${s.botTurns} bot turns`]),
    ...(s.bystanderWakes === 0 ? [] : [`${BYSTANDER} woken ${s.bystanderWakes} times`]),
    ...(s.chainStopped === 0 ? [] : ["chain stopped"]),
  ];
};

const HEADER = [
  `| Run | Result | File | Content | Bot turns | Turns | ${BYSTANDER}'s wakes | Chain stopped | Hops / limit | Minutes |`,
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

const passed = (outcome: Run | Broken) =>
  outcome._tag === "scored" && failures(outcome).length === 0;

const row = (index: number, outcome: Run | Broken) => {
  if (outcome._tag === "broken") {
    return `| ${index} | error: ${outcome.reason} | | | | | | | | |`;
  }
  const s: Score = outcome.score;
  const failed = failures(outcome);
  const cells = [
    index,
    failed.length === 0 ? "pass" : `fail (${failed.join("; ")})`,
    Option.isSome(outcome.content) ? "yes" : "no",
    Option.match(outcome.content, {
      onNone: () => "",
      onSome: (problems) => (problems.length === 0 ? "right" : "wrong"),
    }),
    s.botTurns,
    s.sequence.join(" → "),
    s.bystanderWakes,
    s.chainStopped,
    `${s.maxHops} / ${outcome.hopLimit}`,
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
  const runs = yield* Config.Int("J3_EVAL_RUNS").pipe(Config.withDefault(5));
  const port = yield* Config.Port("J3_EVAL_PORT").pipe(Config.withDefault(3861));
  const model = yield* Config.option(Config.String("J3_EVAL_MODEL"));
  const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const repo = path.resolve(here, "..", "..");
  const { version } = yield* fs
    .readFileString(path.join(repo, "engine.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(EnginePin)));

  // Every run's home and log, and with them the stored connection, are gone when the eval ends.
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-evals-room-" });
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
    yield* Console.log(`Run ${index} of ${runs}`);
    const outcome: Run | Broken = yield* runOnce(spec, log, endpoint, model).pipe(
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
    yield* fs.remove(home, { recursive: true });
    const line = row(index, outcome);
    yield* Console.log(line);
    outcomes.push(outcome);
  }
  yield* Console.log(
    ["", ...HEADER, ...outcomes.map((outcome, i) => row(i + 1, outcome))].join("\n"),
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
