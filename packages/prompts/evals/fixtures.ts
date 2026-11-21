// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import {
  fail,
  ok,
  type Outcome,
  type Program,
  type ShellEvent,
  type Unavailable,
  Workspace,
} from "./shell.ts";

/**
 * A stand-in `gh` for the fictional repository acme/docs: its CI runs on
 * `main` and its pull requests. It serves reads only, with GitHub's output
 * shapes, and reports what it showed, so a grader checks that a run looked at
 * the build rather than how it spelled the command.
 *
 * Supported, against acme/docs (`-R`, `--repo` or `GH_REPO`):
 *
 * - `gh run list` (`--branch`, `--limit`, `--workflow`, `--status`,
 *   `--event`, `--json`): `main`'s runs; another branch has no runs;
 * - `gh run view <id>` (`--log`, `--log-failed`, `--job`, `--json`,
 *   `--verbose`, `--exit-status`);
 * - `gh pr list` (`--state`, `--limit`, `--json`) and `gh pr view <number>`
 *   (`--json`, `--comments`);
 * - `gh api` GETs of `repos/acme/docs/actions/runs` (with `branch`,
 *   `status`, `event`, `per_page`, `page`), a run, its jobs, a job, a job's
 *   logs, a check run's annotations, `repos/acme/docs/pulls` (with `state`)
 *   and one pull request;
 * - `gh auth status` and `gh --version`.
 *
 * Anything that would change GitHub (a rerun, a merge, a comment, an API call
 * that is not a GET) is refused and reported as a change. Everything else,
 * including `--jq`, `--template` and help, fails with an error that says it
 * is not available here, reported as unavailable: what it would have done is
 * unknown.
 */

/** What `gh` did that a grader checks. */
export type GhEvent =
  /** A `gh` that would reach GitHub: any but `gh --version` and help. */
  | { readonly type: "gh" }
  /** A `gh` that would change something on GitHub; refused here. */
  | { readonly type: "gh-change"; readonly command: string }
  /** acme/docs's CI runs, or a run's jobs, logs or annotations, were shown. */
  | { readonly type: "build-read" }
  /** A list of acme/docs's pull requests was shown, holding these numbers. */
  | { readonly type: "pull-requests-read"; readonly numbers: ReadonlyArray<number> }
  /** One pull request was shown. */
  | { readonly type: "pull-request-read"; readonly number: number };

export type FixtureEvent = GhEvent | ShellEvent;

interface Job {
  readonly id: number;
  readonly name: string;
  readonly conclusion: "success" | "failure";
  readonly duration: string;
  /** The failing step and the first error line its log shows, for a failed job. */
  readonly failure?: { readonly step: string; readonly path: string; readonly error: string };
}

export interface Run {
  readonly id: number;
  readonly title: string;
  readonly conclusion: "success" | "failure";
  readonly elapsed: string;
  readonly minutesAgo: number;
  readonly jobs: ReadonlyArray<Job>;
}

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly branch: string;
  readonly state: "open" | "merged";
  readonly minutesAgo: number;
  /** For a merged pull request, how long ago it merged. */
  readonly mergedMinutesAgo?: number;
}

export interface GitHub {
  /** The time the fixture's ages are counted from: the wake's. */
  readonly now: DateTime.Utc;
  /** `main`'s runs, newest first. */
  readonly runs: ReadonlyArray<Run>;
  readonly pullRequests: ReadonlyArray<PullRequest>;
  /** `false` when the sign-in has expired: every call then meets a 401. */
  readonly signedIn: boolean;
}

const REPO = "acme/docs";
const WORKFLOW = { name: "Build docs", file: "build.yml" } as const;
const DOCS = /^(?:(?:https:\/\/)?github\.com\/)?acme\/docs$/;

const age = (minutes: number): string => {
  if (minutes < 60) return `about ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "about 1 hour ago" : `about ${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "about 1 day ago" : `about ${days} days ago`;
};

const json = (value: unknown): Outcome => ok(`${JSON.stringify(value)}\n`);

/** What `gh` reports to the graders. */
type Recorder = (event: GhEvent | Unavailable) => void;

const notAvailable = (what: string): Outcome =>
  fail(`gh: ${what} is not available in this workspace.`);

/** An error for what this `gh` does not offer, reported as unavailable. */
const notHere = (record: Recorder, what: string): Outcome => {
  record({ type: "unavailable", what: `gh: ${what}` });
  return notAvailable(what);
};

// Flags.

interface FlagSpec {
  readonly long: string;
  readonly short?: string;
  readonly value: boolean;
}

const REPO_FLAG: FlagSpec = { long: "repo", short: "R", value: true };
const JSON_FLAG: FlagSpec = { long: "json", value: true };
const LIMIT_FLAG: FlagSpec = { long: "limit", short: "L", value: true };
/** Flags real `gh` takes that this one does not. */
const UNSUPPORTED = new Set(["--jq", "-q", "--template", "-t", "--web", "-w"]);

interface Parsed {
  readonly flags: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly positional: ReadonlyArray<string>;
}

/** Arguments against `specs`, or an error for a flag it does not know. */
const parseFlags = (
  args: ReadonlyArray<string>,
  specs: ReadonlyArray<FlagSpec>,
  record: Recorder,
): Parsed | Outcome => {
  const flags = new Map<string, Array<string>>();
  const positional: Array<string> = [];
  const add = (spec: FlagSpec, value: string) =>
    flags.set(spec.long, [...(flags.get(spec.long) ?? []), value]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    const long = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
    const spec = specs.find((candidate) =>
      long !== null
        ? candidate.long === long[1]
        : candidate.short !== undefined && arg.startsWith(`-${candidate.short}`),
    );
    if (spec === undefined) {
      const name = long !== null ? `--${long[1] ?? ""}` : arg.slice(0, 2);
      return UNSUPPORTED.has(name)
        ? notHere(record, name)
        : fail(
            `unknown flag: ${name}\nThis workspace's gh takes: ${specs.map((candidate) => `--${candidate.long}`).join(", ")}.`,
          );
    }
    if (!spec.value) {
      add(spec, "");
      continue;
    }
    const inline = long !== null ? long[2] : arg.length > 2 ? arg.slice(2) : undefined;
    const value = inline ?? args[++index];
    if (value === undefined) return fail(`flag needs an argument: ${arg}`);
    add(spec, value);
  }
  return { flags, positional };
};

const isOutcome = (parsed: Parsed | Outcome): parsed is Outcome => "status" in parsed;
const flag = (parsed: Parsed, name: string): string | undefined => parsed.flags.get(name)?.at(-1);
const has = (parsed: Parsed, name: string): boolean => parsed.flags.has(name);

/** A positive count, such as a `--limit`, or an error. */
const count = (value: string | undefined, fallback: number): number | Outcome =>
  value === undefined
    ? fallback
    : /^\d+$/.test(value) && Number(value) > 0
      ? Number(value)
      : fail(`invalid limit: ${value}`);

type Fields = { readonly [field: string]: unknown };

/**
 * The `--json` fields asked for, of one object or of a list, or an error
 * naming the fields that exist.
 */
const pick = (
  fields: string,
  value: Fields | ReadonlyArray<Fields>,
  available: ReadonlyArray<string>,
): Outcome => {
  const names = fields.split(",").map((name) => name.trim());
  const unknown = names.find((name) => !available.includes(name));
  if (unknown !== undefined) {
    return fail(
      `Unknown JSON field: ${JSON.stringify(unknown)}\nAvailable fields:\n  ${available.join("\n  ")}`,
    );
  }
  const keep = (object: Fields) => Object.fromEntries(names.map((name) => [name, object[name]]));
  return json(isList(value) ? value.map(keep) : keep(value));
};

const isList = (value: Fields | ReadonlyArray<Fields>): value is ReadonlyArray<Fields> =>
  Array.isArray(value);

/** The repository a command names, or an error when it names none or another. */
const repository = (parsed: Parsed, env: ReadonlyMap<string, string>): Outcome | undefined => {
  const repo = flag(parsed, "repo") ?? env.get("GH_REPO");
  if (repo === undefined) {
    return fail(
      "could not determine base repo: this workspace is not a git repository; pass --repo OWNER/REPO",
    );
  }
  return DOCS.test(repo)
    ? undefined
    : fail(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`);
};

/** The stand-in `gh` for `github`. */
const gh =
  (github: GitHub): Program<GhEvent> =>
  (args, { env, record }) => {
    if (args[0] === "--version") return ok("gh version 2.83.0 (2026-10-01)\n");
    const options = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
    if (
      args.length === 0 ||
      args[0] === "help" ||
      options.includes("--help") ||
      options.includes("-h")
    ) {
      return notHere(record, "help");
    }
    record({ type: "gh" });
    if (!github.signedIn) {
      return args[0] === "auth" && args[1] === "status"
        ? fail("You are not logged into any GitHub hosts. To log in, run: gh auth login")
        : fail(
            "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login",
          );
    }
    const change = (): Outcome => {
      record({ type: "gh-change", command: `gh ${args.join(" ")}` });
      return notAvailable(`a change to GitHub (gh ${args.slice(0, 2).join(" ")})`);
    };
    const data = new Data(github, record);
    switch (args[0]) {
      case "auth":
        return args[1] === "status"
          ? ok("github.com\n  ✓ Logged in to github.com account juniper-docs (keyring)\n")
          : notHere(record, `gh auth ${args[1] ?? ""}`.trim());
      case "run":
        if (["rerun", "cancel", "delete"].includes(args[1] ?? "")) return change();
        if (args[1] === "list") return data.runList(args.slice(2), env);
        if (args[1] === "view") return data.runView(args.slice(2), env);
        return notHere(record, `gh run ${args[1] ?? ""}`.trim());
      case "workflow":
        return args[1] === "run" || args[1] === "enable" || args[1] === "disable"
          ? change()
          : notHere(record, "gh workflow");
      case "pr":
        if (
          ["merge", "comment", "review", "close", "reopen", "edit", "create", "ready"].includes(
            args[1] ?? "",
          )
        ) {
          return change();
        }
        if (args[1] === "list") return data.pullList(args.slice(2), env);
        if (args[1] === "view") return data.pullView(args.slice(2), env);
        return notHere(record, `gh pr ${args[1] ?? ""}`.trim());
      case "api":
        return data.api(args.slice(1), change);
      default:
        return notHere(record, `gh ${args[0] ?? ""}`.trim());
    }
  };

/** acme/docs as `gh` shows it. */
class Data {
  readonly #github: GitHub;
  readonly #record: Recorder;

  constructor(github: GitHub, record: Recorder) {
    this.#github = github;
    this.#record = record;
  }

  #at(minutesAgo: number): string {
    return DateTime.formatIso(DateTime.subtract(this.#github.now, { minutes: minutesAgo }));
  }

  #run(id: number): Run | undefined {
    return this.#github.runs.find((run) => run.id === id);
  }

  #job(id: number): { readonly run: Run; readonly job: Job } | undefined {
    for (const run of this.#github.runs) {
      const job = run.jobs.find((candidate) => candidate.id === id);
      if (job !== undefined) return { run, job };
    }
    return undefined;
  }

  /** `main`'s runs that match a branch, a status and an event; another branch has none. */
  #runs(filter: {
    readonly branch: string | undefined;
    readonly status: string | undefined;
    readonly event: string | undefined;
  }): ReadonlyArray<Run> {
    return this.#github.runs.filter(
      (run) =>
        (filter.branch === undefined || filter.branch === "main") &&
        (filter.event === undefined || filter.event === "push") &&
        (filter.status === undefined || ["completed", run.conclusion].includes(filter.status)),
    );
  }

  #runFields(run: Run): Fields {
    return {
      databaseId: run.id,
      number: run.id - 900,
      attempt: 1,
      displayTitle: run.title,
      name: WORKFLOW.name,
      workflowName: WORKFLOW.name,
      status: "completed",
      conclusion: run.conclusion,
      headBranch: "main",
      headSha: `${run.id}abc`.padEnd(40, "0"),
      event: "push",
      createdAt: this.#at(run.minutesAgo),
      startedAt: this.#at(run.minutesAgo),
      updatedAt: this.#at(run.minutesAgo - 3),
      url: `https://github.com/${REPO}/actions/runs/${run.id}`,
      jobs: run.jobs.map((job) => this.#jobFields(run, job)),
    };
  }

  #jobFields(run: Run, job: Job): Fields {
    return {
      databaseId: job.id,
      name: job.name,
      status: "completed",
      conclusion: job.conclusion,
      startedAt: this.#at(run.minutesAgo),
      completedAt: this.#at(run.minutesAgo - 2),
      url: `https://github.com/${REPO}/actions/runs/${run.id}/job/${job.id}`,
      steps: [
        { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
        {
          number: 2,
          name: job.failure?.step ?? "Build",
          status: "completed",
          conclusion: job.conclusion,
        },
      ],
    };
  }

  #apiRun(run: Run): Fields {
    return {
      id: run.id,
      name: WORKFLOW.name,
      display_title: run.title,
      head_branch: "main",
      event: "push",
      status: "completed",
      conclusion: run.conclusion,
      created_at: this.#at(run.minutesAgo),
      updated_at: this.#at(run.minutesAgo - 3),
      run_started_at: this.#at(run.minutesAgo),
      html_url: `https://github.com/${REPO}/actions/runs/${run.id}`,
      jobs_url: `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/jobs`,
    };
  }

  #apiJob(run: Run, job: Job): Fields {
    return {
      id: job.id,
      run_id: run.id,
      name: job.name,
      status: "completed",
      conclusion: job.conclusion,
      started_at: this.#at(run.minutesAgo),
      completed_at: this.#at(run.minutesAgo - 2),
      html_url: `https://github.com/${REPO}/actions/runs/${run.id}/job/${job.id}`,
      check_run_url: `https://api.github.com/repos/${REPO}/check-runs/${job.id}`,
      steps: [
        { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
        {
          number: 2,
          name: job.failure?.step ?? "Build",
          status: "completed",
          conclusion: job.conclusion,
        },
      ],
    };
  }

  #log(run: Run, job: Job): string {
    const at = this.#at(run.minutesAgo - 1);
    const step = job.failure?.step ?? "Build";
    const lines = [`${job.name}\t${step}\t${at} Run ${step.toLowerCase()}`];
    if (job.failure !== undefined) {
      lines.push(`${job.name}\t${step}\t${at} ##[error]${job.failure.path}: ${job.failure.error}`);
      lines.push(`${job.name}\t${step}\t${at} ##[error]Process completed with exit code 1.`);
    } else lines.push(`${job.name}\t${step}\t${at} Done.`);
    return `${lines.join("\n")}\n`;
  }

  #pullFields(pull: PullRequest): Fields {
    return {
      number: pull.number,
      title: pull.title,
      state: pull.state.toUpperCase(),
      author: { login: pull.author },
      headRefName: pull.branch,
      baseRefName: "main",
      isDraft: false,
      createdAt: this.#at(pull.minutesAgo),
      mergedAt: pull.mergedMinutesAgo === undefined ? null : this.#at(pull.mergedMinutesAgo),
      url: `https://github.com/${REPO}/pull/${pull.number}`,
    };
  }

  #apiPull(pull: PullRequest): Fields {
    return {
      number: pull.number,
      title: pull.title,
      state: pull.state === "open" ? "open" : "closed",
      merged: pull.state === "merged",
      merged_at: pull.mergedMinutesAgo === undefined ? null : this.#at(pull.mergedMinutesAgo),
      user: { login: pull.author },
      head: { ref: pull.branch },
      base: { ref: "main" },
      created_at: this.#at(pull.minutesAgo),
      html_url: `https://github.com/${REPO}/pull/${pull.number}`,
    };
  }

  runList(args: ReadonlyArray<string>, env: ReadonlyMap<string, string>): Outcome {
    const parsed = parseFlags(
      args,
      [
        REPO_FLAG,
        JSON_FLAG,
        LIMIT_FLAG,
        { long: "branch", short: "b", value: true },
        { long: "workflow", short: "w", value: true },
        { long: "status", short: "s", value: true },
        { long: "event", short: "e", value: true },
      ],
      this.#record,
    );
    if (isOutcome(parsed)) return parsed;
    const wrongRepo = repository(parsed, env);
    if (wrongRepo !== undefined) return wrongRepo;
    if (parsed.positional.length > 0)
      return fail(`unknown argument ${JSON.stringify(parsed.positional[0])}`);
    const limit = count(flag(parsed, "limit"), 20);
    if (typeof limit !== "number") return limit;
    const workflow = flag(parsed, "workflow");
    const runs =
      workflow !== undefined && workflow !== WORKFLOW.name && workflow !== WORKFLOW.file
        ? []
        : this.#runs({
            branch: flag(parsed, "branch"),
            status: flag(parsed, "status"),
            event: flag(parsed, "event"),
          }).slice(0, limit);
    const fields = flag(parsed, "json");
    if (fields !== undefined) {
      const available = Object.keys(this.#runFields(EMPTY_RUN)).filter((field) => field !== "jobs");
      const picked = pick(
        fields,
        runs.map((run) => this.#runFields(run)),
        available,
      );
      if (picked.status === 0 && runs.length > 0) this.#record({ type: "build-read" });
      return picked;
    }
    if (runs.length === 0) return ok("no runs found\n");
    this.#record({ type: "build-read" });
    return ok(
      [
        "STATUS     CONCLUSION  TITLE                     WORKFLOW    BRANCH  EVENT  ID    ELAPSED  AGE",
        ...runs.map(
          (run) =>
            `completed  ${run.conclusion.padEnd(10)}  ${run.title.padEnd(24)}  ${WORKFLOW.name}  main    push   ${run.id}  ${run.elapsed.padEnd(7)}  ${age(run.minutesAgo)}`,
        ),
      ].join("\n") + "\n",
    );
  }

  runView(args: ReadonlyArray<string>, env: ReadonlyMap<string, string>): Outcome {
    const parsed = parseFlags(
      args,
      [
        REPO_FLAG,
        JSON_FLAG,
        { long: "log", value: false },
        { long: "log-failed", value: false },
        { long: "job", short: "j", value: true },
        { long: "verbose", short: "v", value: false },
        { long: "exit-status", value: false },
        { long: "attempt", short: "a", value: true },
      ],
      this.#record,
    );
    if (isOutcome(parsed)) return parsed;
    const wrongRepo = repository(parsed, env);
    if (wrongRepo !== undefined) return wrongRepo;
    const jobId = flag(parsed, "job");
    const [runId] = parsed.positional;
    let run: Run | undefined;
    let jobs: ReadonlyArray<Job>;
    if (jobId !== undefined) {
      const found = this.#job(Number(jobId));
      if (found === undefined) return fail(`HTTP 404: Not Found (no job with ID ${jobId})`);
      run = found.run;
      jobs = [found.job];
    } else {
      if (runId === undefined) return fail("run or job ID required when not running interactively");
      run = this.#run(Number(runId));
      if (run === undefined) return fail(`could not find any workflow run with ID ${runId}`);
      jobs = run.jobs;
    }
    const fields = flag(parsed, "json");
    if (fields !== undefined) {
      const object = this.#runFields(run);
      const picked = pick(fields, object, Object.keys(object));
      if (picked.status === 0) this.#record({ type: "build-read" });
      return picked;
    }
    this.#record({ type: "build-read" });
    const failed = run.conclusion === "failure";
    const status = has(parsed, "exit-status") && failed ? 1 : 0;
    if (has(parsed, "log") || has(parsed, "log-failed")) {
      const shown = has(parsed, "log-failed")
        ? jobs.filter((job) => job.conclusion === "failure")
        : jobs;
      const current = run;
      return { stdout: shown.map((job) => this.#log(current, job)).join(""), stderr: "", status };
    }
    const mark = (conclusion: string) => (conclusion === "failure" ? "X" : "✓");
    const failures = jobs.flatMap((job) =>
      job.failure === undefined ? [] : [{ job, failure: job.failure }],
    );
    return {
      stdout:
        [
          `${mark(run.conclusion)} main ${WORKFLOW.name} · ${run.id}`,
          `Triggered via push ${age(run.minutesAgo)}`,
          "",
          "JOBS",
          ...jobs.map(
            (job) => `${mark(job.conclusion)} ${job.name} in ${job.duration} (ID ${job.id})`,
          ),
          ...(failures.length === 0
            ? []
            : [
                "",
                "ANNOTATIONS",
                ...failures.flatMap(({ job, failure }) => [
                  `X ${failure.path}: ${failure.error}`,
                  `${job.name}: ${failure.path}#1`,
                ]),
                "",
                `To see what failed, try: gh run view ${run.id} --log-failed`,
              ]),
          `View this run on GitHub: https://github.com/${REPO}/actions/runs/${run.id}`,
        ].join("\n") + "\n",
      stderr: "",
      status,
    };
  }

  pullList(args: ReadonlyArray<string>, env: ReadonlyMap<string, string>): Outcome {
    const parsed = parseFlags(
      args,
      [REPO_FLAG, JSON_FLAG, LIMIT_FLAG, { long: "state", short: "s", value: true }],
      this.#record,
    );
    if (isOutcome(parsed)) return parsed;
    const wrongRepo = repository(parsed, env);
    if (wrongRepo !== undefined) return wrongRepo;
    const state = flag(parsed, "state") ?? "open";
    if (!["open", "closed", "merged", "all"].includes(state))
      return fail(`invalid argument "${state}" for "--state"`);
    const limit = count(flag(parsed, "limit"), 30);
    if (typeof limit !== "number") return limit;
    const pulls = this.#github.pullRequests
      // As on GitHub, a merged pull request is also closed.
      .filter(
        (pull) =>
          state === "all" || pull.state === state || (state === "closed" && pull.state !== "open"),
      )
      .toSorted((a, b) => b.number - a.number)
      .slice(0, limit);
    const numbers = pulls.map((pull) => pull.number);
    const fields = flag(parsed, "json");
    if (fields !== undefined) {
      const picked = pick(
        fields,
        pulls.map((pull) => this.#pullFields(pull)),
        Object.keys(this.#pullFields(EMPTY_PULL)),
      );
      if (picked.status === 0) this.#record({ type: "pull-requests-read", numbers });
      return picked;
    }
    this.#record({ type: "pull-requests-read", numbers });
    if (pulls.length === 0)
      return ok(`no ${state === "all" ? "" : `${state} `}pull requests in ${REPO}\n`);
    return ok(
      [
        `Showing ${pulls.length} of ${pulls.length} ${state === "all" ? "" : `${state} `}pull requests in ${REPO}`,
        "",
        ...pulls.map(
          (pull) =>
            `#${pull.number}  ${pull.title.padEnd(38)}${pull.author}:${pull.branch}  ${age(pull.minutesAgo)}`,
        ),
      ].join("\n") + "\n",
    );
  }

  pullView(args: ReadonlyArray<string>, env: ReadonlyMap<string, string>): Outcome {
    const parsed = parseFlags(
      args,
      [REPO_FLAG, JSON_FLAG, { long: "comments", short: "c", value: false }],
      this.#record,
    );
    if (isOutcome(parsed)) return parsed;
    const [reference] = parsed.positional;
    const url = /^https:\/\/github\.com\/(acme\/docs)\/pull\/(\d+)$/.exec(reference ?? "");
    if (url === null) {
      const wrongRepo = repository(parsed, env);
      if (wrongRepo !== undefined) return wrongRepo;
    }
    if (reference === undefined)
      return fail(
        "could not determine the pull request: no current branch in this workspace; give its number",
      );
    const number = Number(url?.[2] ?? reference.replace(/^#/, ""));
    const pull = this.#github.pullRequests.find((candidate) => candidate.number === number);
    if (pull === undefined)
      return fail(
        `GraphQL: Could not resolve to a PullRequest with the number of ${reference}. (repository.pullRequest)`,
      );
    const fields = flag(parsed, "json");
    if (fields !== undefined) {
      const picked = pick(
        fields,
        this.#pullFields(pull),
        Object.keys(this.#pullFields(EMPTY_PULL)),
      );
      if (picked.status === 0) this.#record({ type: "pull-request-read", number });
      return picked;
    }
    this.#record({ type: "pull-request-read", number });
    const merged = pull.mergedMinutesAgo;
    return ok(
      [
        `${pull.title} ${REPO}#${pull.number}`,
        merged === undefined
          ? `Open • ${pull.author} wants to merge into main from ${pull.branch} • ${age(pull.minutesAgo)}`
          : `Merged • ${pull.author} merged into main from ${pull.branch} • ${age(merged)}`,
        "",
        `View this pull request on GitHub: https://github.com/${REPO}/pull/${pull.number}`,
      ].join("\n") + "\n",
    );
  }

  api(args: ReadonlyArray<string>, change: () => Outcome): Outcome {
    const parsed = parseFlags(
      args,
      [
        { long: "method", short: "X", value: true },
        { long: "header", short: "H", value: true },
        { long: "raw-field", short: "f", value: true },
        { long: "field", short: "F", value: true },
        { long: "paginate", value: false },
      ],
      this.#record,
    );
    if (isOutcome(parsed)) return parsed;
    const [endpoint] = parsed.positional;
    if (endpoint === undefined || parsed.positional.length > 1)
      return fail("gh api takes exactly one endpoint");
    const fields = [...(parsed.flags.get("raw-field") ?? []), ...(parsed.flags.get("field") ?? [])];
    const method = (flag(parsed, "method") ?? (fields.length > 0 ? "POST" : "GET")).toUpperCase();
    if (method !== "GET") return change();
    const url = new URL(
      endpoint.replace(/^https:\/\/api\.github\.com/, "").replace(/^\/?/, "/"),
      "https://api.github.com",
    );
    for (const field of fields) {
      const [name, ...value] = field.split("=");
      if (name !== undefined) url.searchParams.set(name, value.join("="));
    }
    const path = url.pathname.replace(/\/+$/, "");
    const query = (name: string) => url.searchParams.get(name) ?? undefined;
    if (!path.startsWith(`/repos/${REPO}/`)) return fail("gh: Not Found (HTTP 404)");
    const rest = path.slice(`/repos/${REPO}`.length);
    let match: RegExpExecArray | null;

    if ((match = /^\/actions(?:\/workflows\/([^/]+))?\/runs$/.exec(rest)) !== null) {
      const workflow = match[1];
      const perPage = Number(query("per_page") ?? "30");
      const page = Number(query("page") ?? "1");
      const runs =
        workflow !== undefined && workflow !== WORKFLOW.file && workflow !== "1"
          ? []
          : this.#runs({ branch: query("branch"), status: query("status"), event: query("event") });
      const shown = runs.slice((page - 1) * perPage, page * perPage);
      if (shown.length > 0) this.#record({ type: "build-read" });
      return json({
        total_count: runs.length,
        workflow_runs: shown.map((run) => this.#apiRun(run)),
      });
    }
    if ((match = /^\/actions\/runs\/(\d+)(\/jobs)?$/.exec(rest)) !== null) {
      const run = this.#run(Number(match[1]));
      if (run === undefined) return fail("gh: Not Found (HTTP 404)");
      this.#record({ type: "build-read" });
      return match[2] === undefined
        ? json(this.#apiRun(run))
        : json({
            total_count: run.jobs.length,
            jobs: run.jobs.map((job) => this.#apiJob(run, job)),
          });
    }
    if ((match = /^\/actions\/jobs\/(\d+)(\/logs)?$/.exec(rest)) !== null) {
      const found = this.#job(Number(match[1]));
      if (found === undefined) return fail("gh: Not Found (HTTP 404)");
      this.#record({ type: "build-read" });
      return match[2] === undefined
        ? json(this.#apiJob(found.run, found.job))
        : ok(this.#log(found.run, found.job).replace(/^[^\t]*\t[^\t]*\t/gm, ""));
    }
    if ((match = /^\/check-runs\/(\d+)\/annotations$/.exec(rest)) !== null) {
      const found = this.#job(Number(match[1]));
      if (found === undefined) return fail("gh: Not Found (HTTP 404)");
      this.#record({ type: "build-read" });
      const failure = found.job.failure;
      return json(
        failure === undefined
          ? []
          : [
              {
                path: failure.path,
                start_line: 1,
                annotation_level: "failure",
                message: failure.error,
              },
            ],
      );
    }
    if (rest === "/pulls") {
      const state = query("state") ?? "open";
      const pulls = this.#github.pullRequests
        .filter(
          (pull) =>
            state === "all" || (state === "open" ? pull.state === "open" : pull.state !== "open"),
        )
        .toSorted((a, b) => b.number - a.number);
      this.#record({ type: "pull-requests-read", numbers: pulls.map((pull) => pull.number) });
      return json(pulls.map((pull) => this.#apiPull(pull)));
    }
    if ((match = /^\/pulls\/(\d+)$/.exec(rest)) !== null) {
      const number = Number(match[1]);
      const pull = this.#github.pullRequests.find((candidate) => candidate.number === number);
      if (pull === undefined) return fail("gh: Not Found (HTTP 404)");
      this.#record({ type: "pull-request-read", number });
      return json(this.#apiPull(pull));
    }
    return notHere(this.#record, `GET ${path}`);
  }
}

const EMPTY_RUN: Run = {
  id: 0,
  title: "",
  conclusion: "success",
  elapsed: "",
  minutesAgo: 0,
  jobs: [],
};
const EMPTY_PULL: PullRequest = {
  number: 0,
  title: "",
  author: "",
  branch: "",
  state: "open",
  minutesAgo: 0,
};

/** A workspace whose `gh` reaches `github`, with `files` in it. */
export const githubWorkspace = (
  github: GitHub,
  files: ReadonlyMap<string, string> = new Map(),
): Workspace<GhEvent> => new Workspace({ programs: new Map([["gh", gh(github)]]), files });
