// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId } from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, type RoutineRunSummary, tools, type Wake } from "../src/index.ts";
import {
  type Call,
  commandOf,
  runTurn,
  type Scenario,
  type Shell,
  type Skills,
  transcript,
} from "./harness.ts";
import { type SimpleCommand, simpleCommands } from "./shell.ts";

// The routine skill's evals: given the base prompt, with the skill and without
// it, a model creates a routine for recurring work, with a valid schedule and
// an instruction that stands alone; creates none for a one-off request; and in
// a routine run stays silent when a condition is not met, but speaks when it
// is, when a reminder is due, and when it could not do the work, unless a
// recent run already said what blocks it; a run that keeps a state file writes
// it only after its message. Each case is one turn per model and skill column,
// scored on its tool calls.

/** The models to evaluate, cheapest adequate first. Override with a comma-separated `J3_EVAL_MODELS`. */
const MODELS = Effect.runSync(
  Config.String("J3_EVAL_MODELS").pipe(Config.withDefault("claude-haiku-5-5,gpt-6-luna")),
)
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");

const timeZone = DateTime.zoneMakeNamedUnsafe("Europe/Lisbon");

/**
 * Today at `hour:minute` in the operator's zone. The fixtures take their date
 * from the real current date, as the server takes a wake's time from its
 * clock, so no date in a wake disagrees with one the model was given
 * elsewhere and invites a correction.
 */
const todayAt = (hour: number, minute: number): DateTime.Utc =>
  DateTime.toUtc(
    DateTime.setParts(DateTime.makeZonedUnsafe(DateTime.nowUnsafe(), { timeZone }), {
      hour,
      minute,
      second: 0,
      millisecond: 0,
    }),
  );

/** When the operator writes. */
const at = todayAt(9, 41);
const base = { at, timeZone, sinceLastTurn: [] } as const;

const userWake = (text: string): Wake => ({
  ...base,
  kind: "user",
  answer: null,
  messages: [{ at, text, attachments: [] }],
});

/** The instruction the skill gives as its example, saved for a weekday check of the docs build. */
const DOCS_CHECK =
  "Check the latest CI run on the `main` branch of the GitHub repository acme/docs. Report it if the run failed or has been running for more than 30 minutes; a passing run is not news. When it failed, name the failing job and the first error line. Do not re-run jobs or push anything. If there is a problem, send your user one short message saying what is wrong; if the build is passing, end without saying anything.";

/** When a routine run starts: the time its daily schedule names. */
const runAt = todayAt(8, 7);

const daysAgo = (days: number) => DateTime.subtract(runAt, { days });

const quietRuns: ReadonlyArray<RoutineRunSummary> = [1, 2, 3].map((days): RoutineRunSummary => ({
  at: daysAgo(days),
  outcome: { type: "silent", note: null },
}));

const routineWake: Wake = {
  ...base,
  at: runAt,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-1"),
    name: "Docs build watch",
    // Daily, so the run is due whatever weekday the evals run on.
    trigger: { type: "schedule", cron: "7 8 * * *" },
    instruction: DOCS_CHECK,
  },
  recentRuns: quietRuns,
  triggerData: null,
};

/** The same watch, the day after a run told your user its GitHub sign-in had expired. */
const blockerReportedWake: Wake = {
  ...routineWake,
  recentRuns: [
    {
      at: daysAgo(1),
      outcome: {
        type: "delivered",
        text: "I couldn't check the docs build: GitHub sign-in expired (HTTP 401).",
      },
    },
    ...quietRuns.slice(1),
  ],
};

/** A date as the operator reads it, such as "Friday, 20 November 2026", or a part of it. */
const local = (when: DateTime.Utc, parts: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: DateTime.zoneToString(timeZone), ...parts }).format(
    DateTime.toDateUtc(when),
  );

/** A one-time reminder, as the skill would save "remind me at 9 to submit my expenses". */
const reminderAt = todayAt(9, 0);
const reminderWake: Wake = {
  ...base,
  at: reminderAt,
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-2"),
    name: "Expense report reminder",
    trigger: { type: "once" },
    instruction: `Remind your user to submit their ${local(reminderAt, { month: "long" })} expense report in the Acme expenses portal; it is due on ${local(reminderAt, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} at 18:00. Send them one short message saying so.`,
  },
  recentRuns: [],
  triggerData: null,
};

/** The state file a pull-request watch keeps, and what it holds before this run. */
const STATE_FILE = "files/docs-prs.json";
const STATE = JSON.stringify({ reported: [118, 121] });

/** An hourly watch for new pull requests that keeps what it reported in a state file, as the skill teaches. */
const pullRequestWake: Wake = {
  ...base,
  at: todayAt(10, 17),
  kind: "routine",
  routine: {
    id: Schema.decodeSync(RoutineId)("routine-3"),
    name: "New docs pull requests",
    trigger: { type: "schedule", cron: "17 8-18 * * *" },
    instruction: `Tell your user about pull requests on the GitHub repository acme/docs that they have not heard about yet. The file ${STATE_FILE} lists, under "reported", the numbers of the open pull requests already reported; read it first. If an open pull request is not in that list, send your user one short message naming each new one by number and title; if there is none, end without saying anything. Do not comment on, review or merge anything. As your last step, after any message, write the numbers of all open pull requests to "reported" in ${STATE_FILE}.`,
  },
  recentRuns: [
    {
      at: todayAt(9, 17),
      outcome: {
        type: "delivered",
        text: "New on acme/docs: #121 Add French translation of quickstart.",
      },
    },
    { at: todayAt(8, 17), outcome: { type: "silent", note: null } },
  ],
  triggerData: null,
};

const PULL_REQUESTS = [
  { number: 125, title: "Fix broken anchors in FAQ", author: "lena", age: "about 20 minutes ago" },
  {
    number: 124,
    title: "Document the new search API",
    author: "omar",
    age: "about 40 minutes ago",
  },
  {
    number: 121,
    title: "Add French translation of quickstart",
    author: "claire",
    age: "about 1 hour ago",
  },
  { number: 118, title: "Update install guide for Node 22", author: "rui", age: "about 1 day ago" },
] as const;

const PASSING = [
  "STATUS     TITLE                        WORKFLOW    BRANCH  EVENT  ID    ELAPSED  AGE",
  "completed  success  Fix typo in setup guide  Build docs  main    push   1042  3m12s    about 1 hour ago",
  "completed  success  Bump theme to 4.2        Build docs  main    push   1041  3m40s    about 1 day ago",
].join("\n");

const FAILING = [
  "STATUS     TITLE                        WORKFLOW    BRANCH  EVENT  ID    ELAPSED  AGE",
  "completed  failure  Add pricing page         Build docs  main    push   1043  2m40s    about 30 minutes ago",
  "completed  success  Fix typo in setup guide  Build docs  main    push   1042  3m12s    about 1 hour ago",
  "",
  "X main Build docs · 1043",
  "JOBS",
  "X link-check in 1m02s",
  "ANNOTATIONS",
  "X guides/pricing.md: link to /plans returns 404",
].join("\n");

/** The `gh` commands a command runs; `echo 'gh run list'` runs none. */
const ghCommands = (command: string): ReadonlyArray<SimpleCommand> =>
  simpleCommands(command).filter((simple) => simple.program === "gh");

/** acme/docs as `gh` takes a repository: `acme/docs`, or with its host in front. */
const DOCS_REPO = /^(?:(?:https:\/\/)?github\.com\/)?acme\/docs$/;

/** Whether a `gh` command names acme/docs with `-R`, `--repo` or `GH_REPO`. */
const targetsDocs = ({ env, args }: SimpleCommand): boolean =>
  DOCS_REPO.test(env.get("GH_REPO") ?? "") ||
  args.some(
    (arg, index) =>
      DOCS_REPO.test(arg.replace(/^(-R|--repo=)/, "")) &&
      (/^(-R|--repo=)./.test(arg) || ["-R", "--repo"].includes(args[index - 1] ?? "")),
  );

const WRITES = /\b(rerun|cancel|delete|approve)\b/i;
/** Options that make `gh api` send something other than a GET. */
const API_BODY = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** A `gh api` read, a GET, of a path `path` matches. */
const apiRead = ({ args }: SimpleCommand, path: RegExp): boolean => {
  if (args[0] !== "api" || args.some((arg) => WRITES.test(arg))) return false;
  const method = args.flatMap((arg, index) =>
    arg === "-X" || arg === "--method"
      ? [args[index + 1] ?? ""]
      : /^(-X|--method=)./.test(arg)
        ? [arg.replace(/^(-X|--method=)/, "")]
        : [],
  );
  const get =
    method.length > 0
      ? method.every((name) => name.toUpperCase() === "GET")
      : !args.some((arg) => API_BODY.has(arg));
  return get && args.slice(1).some((arg) => path.test(arg));
};

/** A read-only look at acme/docs's CI runs: `gh run list`/`view` there, or a `gh api` read of its runs or jobs. */
const checksBuild = (command: string): boolean =>
  ghCommands(command).some(
    (gh) =>
      (gh.args[0] === "run" && ["list", "view"].includes(gh.args[1] ?? "") && targetsDocs(gh)) ||
      apiRead(gh, /^\/?repos\/acme\/docs\/actions\/(runs|jobs)\b/),
  );

/** Any `gh` command at all: with an expired sign-in, each one meets the 401. */
const triesGh = (command: string): boolean => ghCommands(command).length > 0;

const UNAVAILABLE = "sh: this command is not available in this workspace";
const GH_NOT_FOUND = "gh: Not Found (HTTP 404)";

/** A shell that answers `output` to a read-only look at the build, and an error to anything else. */
const buildShell =
  (output: string) =>
  (command: string): string =>
    checksBuild(command) ? output : triesGh(command) ? GH_NOT_FOUND : UNAVAILABLE;

/** A shell whose GitHub sign-in has expired. */
const signedOutShell = (command: string): string =>
  triesGh(command)
    ? [
        "HTTP 401: Bad credentials (https://api.github.com/repos/acme/docs/actions/runs)",
        "Try authenticating with:  gh auth login",
      ].join("\n")
    : UNAVAILABLE;

/** Whether a path is the state file, however the command spells its folder. */
const isStateFile = (path: string): boolean => /(^|\/)files\/docs-prs\.json$/.test(path);

const INTERPRETER = /^(python3?|node|bun|deno)$/;

/** Whether a simple command writes the state file: a redirection, `tee`, a move or copy onto it, an in-place edit, or a script that opens it for writing. */
const writesState = ({ program, args, writes }: SimpleCommand): boolean => {
  if (writes.some(isStateFile)) return true;
  const name = (program ?? "").replace(/^.*\//, "");
  if (["tee", "sponge"].includes(name)) return args.some(isStateFile);
  if (["mv", "cp", "install"].includes(name)) return isStateFile(args.at(-1) ?? "");
  if (["sed", "perl"].includes(name)) {
    return args.some((arg) => /^-\w*i/.test(arg)) && args.some(isStateFile);
  }
  return (
    INTERPRETER.test(name) &&
    args.some(
      (arg) =>
        arg.includes(STATE_FILE) && /['"]w['"]|write_text|writeFile|\.write\(|dump\(/.test(arg),
    )
  );
};

/** Whether a simple command reads the state file without writing it. */
const readsState = (simple: SimpleCommand): boolean =>
  !writesState(simple) &&
  (simple.args.some(isStateFile) ||
    simple.reads.some(isStateFile) ||
    (INTERPRETER.test(simple.program ?? "") &&
      simple.args.some((arg) => arg.includes(STATE_FILE))));

const writesStateFile = (command: string): boolean => simpleCommands(command).some(writesState);
const readsStateFile = (command: string): boolean => simpleCommands(command).some(readsState);

/** A read of acme/docs's open pull requests: `gh pr list` there, or a `gh api` read of its pulls. */
const listsPullRequests = (gh: SimpleCommand): boolean =>
  (gh.args[0] === "pr" && gh.args[1] === "list" && targetsDocs(gh)) ||
  apiRead(gh, /^\/?repos\/acme\/docs\/pulls(?:[?#]|$)/);

const listsPullRequestsCommand = (command: string): boolean =>
  ghCommands(command).some(listsPullRequests);

/** What `gh` answers a pull-request read: a table, or JSON when asked for it. */
const pullRequestOutput = (gh: SimpleCommand): string => {
  if (gh.args[0] === "api") {
    return JSON.stringify(
      PULL_REQUESTS.map(({ number, title, author }) => ({
        number,
        title,
        state: "open",
        user: { login: author },
        html_url: `https://github.com/acme/docs/pull/${number}`,
      })),
    );
  }
  if (gh.args.some((arg) => arg === "--json" || arg.startsWith("--json="))) {
    return JSON.stringify(
      PULL_REQUESTS.map(({ number, title, author }) => ({
        number,
        title,
        author: { login: author },
        url: `https://github.com/acme/docs/pull/${number}`,
      })),
    );
  }
  return [
    "Showing 4 of 4 open pull requests in acme/docs",
    "",
    ...PULL_REQUESTS.map(
      ({ number, title, author, age }) => `#${number}  ${title.padEnd(38)}${author}/branch  ${age}`,
    ),
  ].join("\n");
};

/** What `gh pr view` answers for one of the open pull requests. */
const pullRequestView = (gh: SimpleCommand): string | undefined => {
  if (gh.args[0] !== "pr" || gh.args[1] !== "view" || !targetsDocs(gh)) return undefined;
  const pull = PULL_REQUESTS.find(({ number }) =>
    gh.args.slice(2).some((arg) => arg.replace(/^#/, "") === String(number)),
  );
  return pull === undefined
    ? undefined
    : `${pull.title} acme/docs#${pull.number}\nOpen • ${pull.author} wants to merge into main • ${pull.age}`;
};

/**
 * What a write of the state file leaves in it: the numbers the command spells
 * out after "reported", or, when it computes them (with `jq`, say), the open
 * pull requests, which is what the instruction asks for.
 */
const writtenState = (command: string): string => {
  const listed = /reported\W*:\s*\[([\d,\s]*)\]/.exec(command)?.[1];
  const numbers =
    listed === undefined
      ? PULL_REQUESTS.map(({ number }) => number)
      : listed
          .split(",")
          .map((number) => number.trim())
          .filter((number) => number !== "")
          .map(Number);
  return JSON.stringify({ reported: numbers });
};

/**
 * A shell with the pull-request watch's state file and acme/docs's open pull
 * requests. A write of the file succeeds with no output, and a later read, in
 * the same command or another, shows what was written; a command it cannot
 * place answers an error.
 */
const pullRequestShell = (): Shell => {
  let state = STATE;
  return (command) => {
    const outputs = simpleCommands(command).map((simple): string | undefined => {
      if (simple.program === "gh") {
        if (listsPullRequests(simple)) return pullRequestOutput(simple);
        return pullRequestView(simple) ?? GH_NOT_FOUND;
      }
      if (writesState(simple)) {
        state = writtenState(command);
        return "";
      }
      if (readsState(simple)) return state;
      return undefined;
    });
    const known = outputs.filter((output) => output !== undefined);
    return known.length === 0 ? UNAVAILABLE : known.filter((output) => output !== "").join("\n");
  };
};

const named = (calls: ReadonlyArray<Call>, name: string) =>
  calls.filter((call) => call.name === name);

const decodeSay = Schema.decodeUnknownOption(tools.say.input, DECODE_OPTIONS);

/** The `say` calls the server would accept, decoded, in order. */
const says = (calls: ReadonlyArray<Call>) =>
  named(calls, "say").flatMap((call) => {
    const decoded = decodeSay(call.input);
    return decoded._tag === "Some" ? [{ call, say: decoded.value }] : [];
  });

/** The first `run_command` call whose command `test` accepts. */
const firstCommand = (calls: ReadonlyArray<Call>, test: (command: string) => boolean) =>
  calls.find((call) => {
    const command = commandOf(call);
    return command !== undefined && test(command);
  });

/** The routines the turn created and the stub accepted, as the server would save them. */
const created = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call) =>
    call.routine !== undefined && call.routine.action === "create"
      ? [{ call, routine: call.routine }]
      : [],
  );

/** Words that point back at a conversation the run will not have. */
const BACK_REFERENCE =
  /\b(as (we|you|I) (discussed|said|agreed)|as discussed|mentioned (above|earlier|before)|(the|that) (repo|repository|build|one) (above|we discussed)|this conversation|earlier today)\b/i;

/**
 * Wording that tells a run to end without speaking: "end silently", "finish
 * the run quietly", "end without a message", "stay silent", "say nothing",
 * "do not send anything".
 */
const SILENCE =
  /\b((end|finish|stop)s?( \w+){0,3} (silently|quietly|without|with no)|(stay|remain|keep)s? (quiet|silent)|(say|send|report)s? (nothing|no \w+)|(don['’]t|do not|never) (send|say|message|tell|notify|reply|report|speak|call))\b/i;

/** Words that mark a clause about the healthy case: the build passed, nothing changed, an all-clear; never "non-success". */
const HEALTHY =
  /\b(?<!non-?)(passing|passes|passed|green|succeed(s|ed)?|success(ful)?|((has|did|is) )?not (fail(ed|ing)?|broken|red)|nothing (is )?(new|wrong)|no (new )?(failures?|errors?|problems?)|all[- ]clear|all (is )?(well|good|fine))\b/i;
const OTHERWISE = /\botherwise\b/i;
const FAILURE = /\b(fail\w*|broken|red|problem|error|wrong)\b/i;
/** Words that make a clause conditional. */
const CONDITIONAL = /\b(if|when|whenever|only|unless|until)\b/i;
/** Words that make a clause hold on every run. */
const EVERY_RUN = /\b(every|each|always|regardless|anyway)\b/i;

/**
 * The condition a clause opens with: what follows "if" or "when", up to a
 * colon or a comma that does not go on with "or" or "and".
 */
const CONDITION = /\b(?:if|when|whenever)\b((?:[^,:]|,\s*(?:or|and)\b)*)/i;
const HEALTHY_ALL = new RegExp(HEALTHY.source, "gi");

/** Words that turn the healthy word after them into its opposite: "anything other than success". */
const EXCEPT = /\b(other than|anything but|except)\b/i;

/**
 * Whether a clause is about the healthy case. A clause with a condition is
 * judged by that condition alone: it is healthy when one of its alternatives
 * (joined by "or") names the healthy case and no failure, so "if it is not
 * failed" and "if the build is passing, or its failure was already reported"
 * are healthy, and "if it failed, or is anything other than a success" is not.
 * One without is judged whole, and "otherwise" counts only when the clause
 * does not name a failure.
 */
const isHealthy = (clause: string): boolean => {
  const condition = CONDITION.exec(clause)?.[1];
  if (condition !== undefined) {
    return condition
      .split(/,?\s*\bor\b/i)
      .some(
        (alternative) =>
          HEALTHY.test(alternative) &&
          !EXCEPT.test(alternative) &&
          !FAILURE.test(alternative.replace(HEALTHY_ALL, "")),
      );
  }
  return HEALTHY.test(clause) || (OTHERWISE.test(clause) && !FAILURE.test(clause));
};

/** A verb or noun that delivers something to the user. */
const SEND =
  /\b(send|sends|sending|tell|tells|message|messages|messaging|notify|notifies|report|reports|say|says|saying|reply|replies|ping|let \w+ know)\b/gi;
const NEGATION = /\b(don['’]t|do not|never|no|not|nothing|without)\b/i;

/** Where a phrase ends, whatever follows: a colon, or a turn to another action. */
const PHRASE_END = /:|\b(?:but|then|instead)\b/gi;
/** What separates the items of a list: a comma, "and" or "or", or a comma before either. */
const ITEM_SEPARATOR = /(,\s*(?:(?:and|or)\b)?|\b(?:and|or)\b)/i;
const wordCount = (text: string): number => text.split(/\s+/).filter((word) => word !== "").length;

/**
 * Whether the send at `index` is an item of a list that a negation earlier in
 * its phrase covers: "do not send an all-clear, summary, or message", "end
 * without sending a summary or a message", "do not message or tell anyone".
 * An item joined by "or" is always covered; one joined by a comma or "and"
 * only when it is a noun (after an article, or with nothing after it), so in
 * "do not message Rui, and tell the team" the second send is not.
 */
const negatedByList = (phrase: string, after: string): boolean => {
  const parts = phrase.split(ITEM_SEPARATOR);
  const current = parts.at(-1) ?? "";
  const separator = parts.at(-2);
  if (separator === undefined || !/^\s*(?:a|an|any|the)?\s*$/i.test(current)) return false;
  const noun = /\b(?:a|an|any|the)\b/i.test(current) || /^\s*(?:$|,|\b(?:and|or)\b)/i.test(after);
  if (!/\bor\b/i.test(separator) && !noun) return false;
  // Back through the earlier items, past short ones ("summary"), to the one that holds the verb.
  for (let index = parts.length - 3; index >= 0; index -= 2) {
    const item = parts[index] ?? "";
    if (NEGATION.test(item)) return true;
    if (wordCount(item) > 3) return false;
  }
  return false;
};

/**
 * Whether a clause delivers something that no negation cancels: "send an
 * all-clear" does; "do not send an all-clear", "say nothing" and "do not send
 * an all-clear, summary, or message" do not; and in "don't send an alert, but
 * send an all-clear" the second send does. A negation covers its own phrase,
 * which a comma before a new action ends, and a list that follows it.
 */
const sendsAnyway = (clause: string): boolean =>
  Array.from(clause.matchAll(SEND)).some((match) => {
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + match[0].length);
    if (/^\s+(nothing|no)\b/i.test(after)) return false;
    const phraseStart = Math.max(
      0,
      ...Array.from(before.matchAll(PHRASE_END), (end) => end.index + end[0].length),
    );
    const phrase = before.slice(phraseStart);
    const own = phrase.split(ITEM_SEPARATOR).at(-1) ?? "";
    return !NEGATION.test(own) && !negatedByList(phrase, after);
  });

/**
 * Problems with how an instruction handles the healthy case: it must say to
 * stay silent then, send nothing in a clause about it, and send nothing in a
 * clause that holds on every run and names neither a condition nor a failure
 * ("on every check send an update").
 */
const quietDeliveryProblems = (instruction: string): ReadonlyArray<string> => {
  const clauses = instruction.split(/[.;]/);
  const healthy = clauses.filter(isHealthy);
  const problems: Array<string> = [];
  if (!healthy.some((clause) => SILENCE.test(clause))) {
    problems.push("the instruction does not say to stay silent when nothing is wrong");
  }
  if (healthy.some(sendsAnyway)) {
    problems.push("the instruction sends a message when nothing is wrong");
  }
  const unconditional = clauses.filter(
    (clause) =>
      EVERY_RUN.test(clause) &&
      !CONDITIONAL.test(clause) &&
      !FAILURE.test(clause) &&
      sendsAnyway(clause),
  );
  if (unconditional.length > 0) {
    problems.push(
      `the instruction sends a message on every run: ${JSON.stringify(unconditional[0]?.trim())}`,
    );
  }
  return problems;
};

/** 8 in the morning: "8:00", "08:00", "8am", "8 a.m.", or a bare 8 beside "morning"; never 8 p.m. */
const confirmsMorningEight = (text: string): boolean =>
  !/\b0?8(:00)?\s*p\.?m\b|\b20:00\b/i.test(text) &&
  (/\b0?8:00\b/.test(text) ||
    /\b0?8\s*a\.?m\b/i.test(text) ||
    (/\b0?8\b(?!:\d)/.test(text) && /\bmorning/i.test(text)));

/** Every weekday, Monday to Friday, not a single day. */
const confirmsWeekdays = (text: string): boolean =>
  /\b(weekdays?|work ?days?|mon(day)?s?\s*(-|–|—|to|through|thru)\s*fri(day)?s?)\b/i.test(text);

const SUCCESS_WORD = /\b(green|pass(es|ed|ing)?|success(ful|fully)?|succeed(s|ed)?)\b/gi;
const FAILURE_WORD = /\b(red|fail(s|ed|ing|ures?)?|broken|broke)\b/gi;
/**
 * A negation in the few words before a match: "not green", "isn't passing",
 * "no longer passing", "no failures", "nothing is running or failing".
 */
const NEGATED_BEFORE =
  /(?:\b(?:not|no|never|without|nothing|none|zero|0)|n['’]t)\b(?:\s+[\w'’-]+){0,4}\s*$/i;

/** Whether some match of `words` in `text` stands without a negation in its own clause. */
const statesUnnegated = (text: string, words: RegExp): boolean =>
  Array.from(text.matchAll(words)).some((match) => {
    const clause =
      text
        .slice(0, match.index)
        .split(/[,.;:!?—–()]|\bbut\b/i)
        .at(-1) ?? "";
    return !NEGATED_BEFORE.test(clause);
  });

/** Whether an answer says the build is passing, and nothing in it says it is failing. */
const saysPassing = (text: string): boolean =>
  statesUnnegated(text, SUCCESS_WORD) && !statesUnnegated(text, FAILURE_WORD);

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  /** What is wrong with the turn; empty when it passes. */
  readonly problems: (calls: ReadonlyArray<Call>) => ReadonlyArray<string>;
}

/** Problems with a routine run that must speak exactly once, about what `mentions` matches. */
const speaksOnce = (calls: ReadonlyArray<Call>, mentions: RegExp, what: string) => {
  const said = named(calls, "say");
  return [
    ...(said.length === 1 ? [] : [`called \`say\` ${said.length} times, not once`]),
    ...(says(calls).some(({ say }) => mentions.test(say.text))
      ? []
      : [`the message does not ${what}`]),
    ...["ask", "message_bot", "set_routine"].flatMap((name) =>
      named(calls, name).length > 0 ? [`called \`${name}\``] : [],
    ),
  ];
};

/**
 * Problems with a call that depends on what `source` returned: it must exist,
 * and come in a later model message, since calls sent together are written
 * before any of them returns.
 */
const after = (
  source: Call | undefined,
  dependent: Call | undefined,
  what: { readonly source: string; readonly dependent: string },
): ReadonlyArray<string> =>
  source === undefined
    ? [`never ${what.source}`]
    : dependent !== undefined && dependent.step <= source.step
      ? [`${what.dependent} in the same message as it ${what.source}, or before`]
      : [];

/** Problems with a routine run that must look at the build, with a command `looks` accepts, before it speaks. */
const speaksAfterCheck =
  (looks: (command: string) => boolean) =>
  (calls: ReadonlyArray<Call>): ReadonlyArray<string> =>
    after(firstCommand(calls, looks), named(calls, "say")[0], {
      source: "looked at the build",
      dependent: "spoke",
    });

/** Problems with a routine run that must look at the build, with a command `looks` accepts, and stay silent. */
const silentRun =
  (looks: (command: string) => boolean) =>
  (calls: ReadonlyArray<Call>): ReadonlyArray<string> => [
    ...(firstCommand(calls, looks) === undefined ? ["never looked at the build"] : []),
    ...["say", "ask", "message_bot", "set_routine"].flatMap((name) =>
      named(calls, name).length > 0 ? [`called \`${name}\``] : [],
    ),
  ];

/** The pull requests the state file does not list yet, as a message would name them. */
const NEW_PULL_REQUESTS = [/#?\b124\b|search API/i, /#?\b125\b|anchors/i];

/**
 * Problems with the pull-request watch's run: it reads the state file and the
 * open pull requests, then, in a later message, reports the two new ones in
 * exactly one `say`, and writes the state file only after that `say`, in the
 * same message or a later one.
 */
const stateRunProblems = (calls: ReadonlyArray<Call>): ReadonlyArray<string> => {
  const said = named(calls, "say");
  const [message] = said;
  const writes = calls.filter((call) => {
    const command = commandOf(call);
    return command !== undefined && writesStateFile(command);
  });
  const problems: Array<string> = [
    ...after(firstCommand(calls, readsStateFile), message, {
      source: "read the state file",
      dependent: "spoke",
    }),
    ...after(firstCommand(calls, listsPullRequestsCommand), message, {
      source: "listed the open pull requests",
      dependent: "spoke",
    }),
    ...["ask", "message_bot", "set_routine"].flatMap((name) =>
      named(calls, name).length > 0 ? [`called \`${name}\``] : [],
    ),
  ];
  if (said.length !== 1 || message === undefined) {
    return [...problems, `called \`say\` ${said.length} times, not once`];
  }
  const text = says(calls).find(({ call }) => call === message)?.say.text ?? "";
  if (!NEW_PULL_REQUESTS.every((pull) => pull.test(text))) {
    problems.push("the message does not name both new pull requests, #124 and #125");
  }
  const spoken = calls.indexOf(message);
  if (writes.length === 0) problems.push("never wrote the state file");
  else if (writes.some((call) => calls.indexOf(call) < spoken)) {
    problems.push("wrote the state file before its message");
  }
  return problems;
};

const cases: ReadonlyArray<Case> = [
  {
    name: "creates a routine for recurring work, with a valid schedule and an instruction that stands alone",
    scenario: {
      wake: userWake(
        "the docs build broke twice this week and nobody noticed until customers did. from now on can you check it every weekday morning at 8 and only bother me if it's red?",
      ),
      shell: () => buildShell(PASSING),
    },
    problems: (calls) => {
      const routines = created(calls);
      const [first] = routines;
      if (routines.length !== 1 || first === undefined) {
        return [`${routines.length} accepted \`set_routine\` creates, not one`];
      }
      const { call, routine } = first;
      const problems: Array<string> = [];
      // The turn opens with a `say`, then looks for an existing routine before it creates one.
      if (says(calls)[0]?.call !== calls[0]) problems.push("the first call is not a `say`");
      problems.push(
        ...after(named(calls, "list_routines")[0], call, {
          source: "called `list_routines`",
          dependent: "created the routine",
        }),
      );
      const schedule = routine.schedule ?? "";
      const [minute, hour, day, month, weekday] = schedule.split(/\s+/);
      if (
        minute !== "0" ||
        hour !== "8" ||
        day !== "*" ||
        month !== "*" ||
        !["1-5", "mon-fri"].includes((weekday ?? "").toLowerCase())
      ) {
        problems.push(`schedule ${JSON.stringify(schedule)} is not weekdays at 8:00`);
      }
      const instruction = routine.instruction ?? "";
      if (!instruction.includes("acme/docs")) {
        problems.push("the instruction does not name the repository acme/docs");
      }
      if (!/\b(fail|failed|failing|red|broken)\b/i.test(instruction)) {
        problems.push("the instruction does not say what is worth reporting");
      }
      if (BACK_REFERENCE.test(instruction)) {
        problems.push("the instruction points back at the conversation");
      }
      problems.push(...quietDeliveryProblems(instruction));
      // The turn ends on a `say` with `done: true`, after the routine was saved, confirming what was saved.
      const last = calls.at(-1);
      const closing = says(calls).find((said) => said.call === last);
      if (closing === undefined || calls.indexOf(closing.call) < calls.indexOf(call)) {
        problems.push("the turn does not end with a `say` after the routine was saved");
      } else {
        if (closing.say.done !== true)
          problems.push("the closing `say` does not carry `done: true`");
        if (!confirmsMorningEight(closing.say.text)) {
          problems.push("the closing `say` does not confirm 8:00 in the morning");
        }
        if (!confirmsWeekdays(closing.say.text)) {
          problems.push("the closing `say` does not confirm Monday to Friday");
        }
      }
      return problems;
    },
  },
  {
    name: "answers a one-off request in the turn from a check of the build, with no routine",
    scenario: {
      wake: userWake("is the docs build green right now? the release goes out at noon"),
      shell: () => buildShell(PASSING),
    },
    problems: (calls) => {
      const checked = firstCommand(calls, checksBuild);
      const answer = says(calls).find(
        ({ call, say }) => say.done === true && checked !== undefined && call.step > checked.step,
      );
      return [
        ...(named(calls, "set_routine").length > 0 ? ["called `set_routine`"] : []),
        ...(checked === undefined ? ["never checked the build"] : []),
        ...(answer === undefined
          ? ["no `say` with `done: true` in a message after the check delivered the answer"]
          : saysPassing(answer.say.text)
            ? []
            : ["the answer does not say the build is passing"]),
      ];
    },
  },
  {
    name: "keeps a routine run silent when nothing is worth saying",
    scenario: { wake: routineWake, shell: () => buildShell(PASSING) },
    problems: silentRun(checksBuild),
  },
  {
    name: "speaks once in a routine run when something is worth saying",
    scenario: { wake: routineWake, shell: () => buildShell(FAILING) },
    problems: (calls) => [
      ...speaksAfterCheck(checksBuild)(calls),
      ...speaksOnce(calls, /pricing|link|404/i, "say what failed"),
    ],
  },
  {
    name: "sends a due reminder exactly once",
    scenario: { wake: reminderWake, shell: () => () => UNAVAILABLE },
    problems: (calls) => speaksOnce(calls, /expense/i, "remind about the expense report"),
  },
  {
    name: "says once what blocked a routine run that lost its access",
    scenario: { wake: routineWake, shell: () => signedOutShell },
    problems: (calls) => [
      ...speaksAfterCheck(triesGh)(calls),
      ...speaksOnce(
        calls,
        /\b(auth\w*|credentials?|token|sign(ed)?[- ]?(in|out)|log(ged)?[- ]?(in|out)|access|401|permission)\b/i,
        "name the access problem",
      ),
    ],
  },
  {
    name: "stays silent when a recent run already said what blocks it",
    scenario: { wake: blockerReportedWake, shell: () => signedOutShell },
    problems: silentRun(triesGh),
  },
  {
    name: "reports new pull requests once, then records them in its state file",
    scenario: { wake: pullRequestWake, shell: pullRequestShell },
    problems: stateRunProblems,
  },
];

describe("the quiet-delivery check", () => {
  it.each([
    DOCS_CHECK,
    "If the latest run on main failed, message your user with the job name. Otherwise end silently.",
    "If the build is red, tell your user what broke; if it is green, do not send an all-clear.",
    "If the latest run failed, send Rui one short message naming it. If it is not failed, end silently without messaging.",
    "If the latest run has been going for more than 30 minutes, message your user. If it passed, say nothing. Keep the message to two short sentences.",
    "Report only if the latest run concluded with failure, or if its conclusion is anything other than success. If the build is green, end without sending anything at all.",
    'If its status is "in_progress" or "queued", or its conclusion is "success", it is not red: end the run without sending anything. If red, send Rui one short message. Otherwise end the run with no message at all.',
    "If the build failed, tell your user which job failed. If the build passes, do not send an all-clear, summary, or message.",
    "If it failed, message Rui. If it passed, end without sending a summary or a message.",
    "If it failed, message Rui. If it passed, do not message or tell anyone.",
    "Send Rui one short message only when the latest build has failed; otherwise end silently. Report the latest failed run on each weekday check.",
    "Report to Rui only if the latest build is failing. If it is green or there is no new failure, do not send a message.",
    "If the latest build is red, send Rui a brief message. If it is successful, pending, or there is no conclusive failure, send no message.",
    "If there is a problem not yet reported, send Rui one short message. If the build is passing, or the problem's run ID is already reported, end without saying anything at all.",
    "If the build is red, send your user one short message. Say that this check will report again each weekday until it is fixed. If it is green, end silently.",
    'If its conclusion is "failure" (or any non-success conclusion such as "cancelled" or "timed_out"), send Rui a short message. If the latest completed run succeeded, send nothing at all.',
  ])("accepts %j", (instruction) => {
    expect(quietDeliveryProblems(instruction)).toEqual([]);
  });

  it.each([
    "If the build fails, tell your user. If it passes, don't send a failure alert, but send an all-clear.",
    "If it fails, message your user. Do not message anyone else.",
    "If the build is passing, tell your user it is green.",
    "If it passes, say nothing. On every check send an update.",
    "Send your user the build status every morning. If it passed, end silently.",
    "If it failed, tell Rui. If it is not failed, message your user that it is green.",
    "If it failed, tell Rui. If it passed, don't message the team, and tell Rui it is green.",
    "If it failed, tell Rui. If it passed, end silently, send an all-clear.",
    "If the build is passing, or it failed, send Rui a message. Otherwise end silently.",
  ])("rejects %j", (instruction) => {
    expect(quietDeliveryProblems(instruction)).not.toEqual([]);
  });
});

describe("the one-off answer's polarity check", () => {
  it.each([
    "Yes, it's green: the latest run on main passed about an hour ago.",
    "Green ✅ no failures on main.",
    "The docs build is passing, not red, so the release is clear.",
    "Yes. Both recent runs on main succeeded.",
    "Yes. The latest run on main passed an hour ago. Nothing is running or failing on main right now.",
  ])("reads %j as passing", (text) => {
    expect(saysPassing(text)).toBe(true);
  });

  it.each([
    "The build is not green.",
    "It isn't passing right now.",
    "No, the latest run on main failed.",
    "Not yet green; the run failed on link-check.",
    "The build is no longer passing.",
    "Green on the last run, but the one before it failed.",
  ])("does not read %j as passing", (text) => {
    expect(saysPassing(text)).toBe(false);
  });
});

describe("the shell graders", () => {
  it.each([
    "gh run list -R acme/docs --branch main -L 5",
    "gh run list --repo=acme/docs",
    "GH_REPO=acme/docs gh run view 1043 --log-failed",
    "cd /tmp && gh run list --repo acme/docs | head -5",
    "gh api 'repos/acme/docs/actions/runs?branch=main&per_page=1'",
    "gh api -X GET repos/acme/docs/actions/runs -f branch=main",
    "gh run list -R github.com/acme/docs 2>&1",
  ])("counts %j as a look at the build", (command) => {
    expect(checksBuild(command)).toBe(true);
  });

  it.each([
    "echo 'gh run list -R acme/docs'",
    'echo "x; gh run list -R acme/docs"',
    "gh run list",
    "gh run list -R acme/other",
    "gh run rerun 1043 -R acme/docs",
    "gh api -X POST repos/acme/docs/actions/runs/1043/rerun",
    "gh api repos/acme/docs/actions/runs -f status=completed",
  ])("does not count %j as a look at the build", (command) => {
    expect(checksBuild(command)).toBe(false);
  });

  it("counts any `gh` it runs as an attempt, and none it only prints", () => {
    expect(triesGh("gh auth status")).toBe(true);
    expect(triesGh("ls && gh run list")).toBe(true);
    expect(triesGh("echo gh run list")).toBe(false);
  });

  it.each([
    `echo '{"reported":[118,121,124,125]}' > ${STATE_FILE}`,
    `cat > ./${STATE_FILE} <<'EOF'\n{"reported":[118,121,124,125]}\nEOF`,
    `jq '.reported = [118,121,124,125]' ${STATE_FILE} > /tmp/prs && mv /tmp/prs ${STATE_FILE}`,
    `printf '%s' '{"reported":[124]}' | tee ${STATE_FILE} >/dev/null`,
    `python3 -c "import json; json.dump({'reported': [124]}, open('${STATE_FILE}', 'w'))"`,
  ])("counts %j as a write of the state file", (command) => {
    expect(writesStateFile(command)).toBe(true);
  });

  it.each([
    `cat ${STATE_FILE}`,
    `jq .reported ${STATE_FILE}`,
    `cp ${STATE_FILE} /tmp/backup.json`,
    `echo 'x > ${STATE_FILE}'`,
    `cat ${STATE_FILE} > /tmp/copy.json`,
  ])("does not count %j as a write of the state file", (command) => {
    expect(writesStateFile(command)).toBe(false);
  });
});

describe("the state-file run check", () => {
  const command = (step: number, text: string): Call => ({
    step,
    name: "run_command",
    input: { command: text },
  });
  const say = (step: number, text: string): Call => ({
    step,
    name: "say",
    input: { text, done: true },
  });
  const look = [command(1, `cat ${STATE_FILE}`), command(1, "gh pr list -R acme/docs")];
  const report =
    "New on acme/docs: #124 Document the new search API, #125 Fix broken anchors in FAQ.";
  const write = (step: number) =>
    command(step, `echo '{"reported":[118,121,124,125]}' > ${STATE_FILE}`);

  it.each([
    ["a write in a later message", [...look, say(2, report), write(3)]],
    ["a write later in the same message", [...look, say(2, report), write(2)]],
  ])("accepts %s", (_, calls) => {
    expect(stateRunProblems(calls)).toEqual([]);
  });

  it.each([
    ["no write", [...look, say(2, report)]],
    ["a write earlier in the same message", [...look, write(2), say(2, report)]],
    ["a write before the message and after it", [...look, write(2), say(3, report), write(4)]],
    ["a message sent with the reads", [...look, say(1, report), write(2)]],
    ["two messages", [...look, say(2, report), say(3, report), write(4)]],
    [
      "a message missing #125",
      [...look, say(2, "New: #124 Document the new search API."), write(3)],
    ],
    [
      "no read of the state file",
      [command(1, "gh pr list -R acme/docs"), say(2, report), write(3)],
    ],
  ])("rejects %s", (_, calls) => {
    expect(stateRunProblems(calls)).not.toEqual([]);
  });
});

describe("the pull-request watch's shell", () => {
  it("shows a write of the state file to every later read in the same turn", () => {
    const written = JSON.stringify({ reported: [118, 121, 124, 125] });
    const shell = pullRequestShell();
    expect(shell(`cat ${STATE_FILE}`)).toBe(STATE);
    expect(shell(`echo '${written}' > ${STATE_FILE} && cat ${STATE_FILE}`)).toBe(written);
    expect(shell(`cat ${STATE_FILE}`)).toBe(written);
    expect(pullRequestShell()(`cat ${STATE_FILE}`)).toBe(STATE);
  });
});

const SKILL_COLUMNS: ReadonlyArray<Skills> = ["with the skill", "without the skill"];

describe.each(MODELS)("%s", (model) => {
  describe.each(SKILL_COLUMNS)("%s", (skills) => {
    it.concurrent.each(cases)("$name", async ({ scenario, problems }) => {
      const turn = await Effect.runPromise(runTurn(model, skills, scenario));
      expect(problems(turn.calls), transcript(turn)).toEqual([]);
    });
  });
});
