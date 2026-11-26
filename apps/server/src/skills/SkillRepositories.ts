// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  checkedAddresses,
  DEFAULT_GUARD,
  type ResolvedAddress,
  type Resolver,
  type UrlPolicy,
} from "@j3-bots/connectors";
import {
  type CommitId,
  type GitRef,
  type GitRepository,
  type RepositoryPath,
  SKILL_LIMITS,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The file a harness reads in a skill's folder. */
export const SKILL_FILE = "SKILL.md";

/**
 * A repository could not be fetched: its address refused by J3 Bots' own
 * check (`refused`, or `private-network` for an address in the operator's
 * network), no answer from it (`unreachable`), no branch, tag or commit of
 * that name (`no-ref`), no `git` 2.37 or later on the server's `PATH`
 * (`no-git`), or the fetch running past its time (`timed-out`).
 */
export class SkillFetchFailed extends Schema.TaggedError<SkillFetchFailed>()("SkillFetchFailed", {
  reason: Schema.Literals([
    "refused",
    "private-network",
    "unreachable",
    "no-ref",
    "no-git",
    "timed-out",
  ]),
}) {
  override get message(): string {
    return `The repository could not be fetched (${this.reason}).`;
  }
}

/** The folder fetched is not a skill J3 Bots installs, for the reason given. */
export class NotASkill extends Schema.TaggedError<NotASkill>()("NotASkill", {
  reason: Schema.String,
}) {}

/** A file of a fetched skill: its path in the skill's folder, `/`-separated, and its bytes. */
export interface SkillFile {
  readonly path: string;
  readonly data: Uint8Array;
}

/** A skill's folder as a repository held it at `commit`. */
export interface FetchedSkill {
  readonly commit: CommitId;
  readonly files: ReadonlyArray<SkillFile>;
}

/**
 * Fetches a skill's folder from a public git repository (decision 0049): one
 * commit, read from git's own objects, with nothing in it run and nothing
 * checked out, so no hook, filter, submodule or link of the repository's ever
 * acts on this machine.
 */
export class SkillRepositories extends Context.Service<
  SkillRepositories,
  {
    readonly fetch: (input: {
      readonly repository: GitRepository;
      readonly path: RepositoryPath;
      readonly ref: GitRef;
    }) => Effect.Effect<FetchedSkill, SkillFetchFailed | NotASkill>;
  }
>()("@j3-bots/server/skills/SkillRepositories") {}

/** How long a whole fetch may take, the repository's download included. */
const FETCH_WITHIN = Duration.minutes(2);

/** The most a listing git prints is read: past it, the fetch fails rather than hold it all. */
const MAX_LISTING_BYTES = 1024 * 1024;

const isCommitId = (ref: string): ref is CommitId => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(ref);

/**
 * git's own configuration for every run: none of the operator's (no system or
 * global file, a home of its own), no prompt for a password, no helper that
 * would hand one over, only `https:` (and plain HTTP to a loopback test host
 * when the policy allows it), no redirect followed, and no hook run.
 */
const hardened = (policy: UrlPolicy): ReadonlyArray<string> => [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  ...(policy.loopback === "allow-http" ? ["-c", "protocol.http.allow=always"] : []),
  "-c",
  "http.followRedirects=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
  "-c",
  "fetch.fsckObjects=true",
];

/**
 * The option that pins git's connections to the addresses J3 Bots checked:
 * curl's own resolve list, which git passes on since 2.37. An IPv6 address
 * goes in brackets.
 */
const pinned = (url: URL, addresses: ReadonlyArray<ResolvedAddress>): ReadonlyArray<string> => {
  const port = url.port === "" ? (url.protocol === "http:" ? "80" : "443") : url.port;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const list = addresses
    .map(({ address, family }) => (family === 6 ? `[${address}]` : address))
    .join(",");
  return ["-c", `http.curloptResolve=${host}:${port}:${list}`];
};

/** One run of git: what it printed, up to `limit` bytes, and how it exited. */
interface Ran {
  readonly output: Uint8Array;
  readonly exitCode: number;
  readonly truncated: boolean;
}

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

/** A tree entry as `git ls-tree -r -z --long` prints it. */
const TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]+) +(-|\d+)\t(.+)$/s;

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The live fetcher, under `policy` and `resolve`: the guard's own for a
 * connector, so a repository on the operator's network or on this machine is
 * refused. Tests reach a local host with a policy that allows it.
 */
export const make = Effect.fn("SkillRepositories.make")(function* (options: {
  readonly policy: UrlPolicy;
  readonly resolve: Resolver;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* Effect.sync(() => process.env);

  const fetch = Effect.fn("SkillRepositories.fetch")(
    function* (input: {
      readonly repository: GitRepository;
      readonly path: RepositoryPath;
      readonly ref: GitRef;
    }) {
      const url = new URL(input.repository);
      const addresses = yield* checkedAddresses(url, options.policy, options.resolve).pipe(
        Effect.catchTags({
          UrlRefused: (refused) =>
            new SkillFetchFailed({
              reason: refused.reason === "private-network" ? "private-network" : "refused",
            }),
          Unreachable: () => new SkillFetchFailed({ reason: "unreachable" }),
        }),
      );
      // A folder of the machine's own for temporary files that cannot be made is not the repository's doing.
      const work = yield* fs.makeTempDirectoryScoped({ prefix: "j3-skill-" }).pipe(Effect.orDie);
      const home = `${work}/home`;
      const repo = `${work}/repository`;
      yield* Effect.orDie(Effect.all([fs.makeDirectory(home), fs.makeDirectory(repo)]));
      // Only what git needs: no proxy, no credential, nothing of the operator's.
      const env: Record<string, string> = {
        PATH: environment["PATH"] ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        LC_ALL: "C",
      };
      const config = [...hardened(options.policy), ...pinned(url, addresses)];

      const git = (args: ReadonlyArray<string>, limit = MAX_LISTING_BYTES) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", [...config, ...args], {
                cwd: repo,
                env,
                extendEnv: false,
                stdin: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: "2 seconds",
              }),
            );
            let size = 0;
            let truncated = false;
            const [chunks, , exitCode] = yield* Effect.all(
              [
                handle.stdout.pipe(
                  Stream.takeWhile((chunk) => {
                    size += chunk.length;
                    truncated = size > limit;
                    return !truncated;
                  }),
                  Stream.runCollect,
                ),
                handle.stderr.pipe(Stream.runDrain),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            const ran: Ran = { output: concat(chunks), exitCode: Number(exitCode), truncated };
            return ran;
          }),
        ).pipe(Effect.catchTag("PlatformError", () => new SkillFetchFailed({ reason: "no-git" })));
      const text = (ran: Ran) => new TextDecoder().decode(ran.output);

      const version = /git version (\d+)\.(\d+)/.exec(text(yield* git(["--version"])));
      if (version === null || Number(version[1]) * 1000 + Number(version[2]) < 2037) {
        return yield* new SkillFetchFailed({ reason: "no-git" });
      }
      yield* git(["init", "--quiet", "--bare", "."]);

      const commit = isCommitId(input.ref)
        ? input.ref
        : yield* Effect.gen(function* () {
            const listed = yield* git([
              "ls-remote",
              url.href,
              `refs/heads/${input.ref}`,
              `refs/tags/${input.ref}`,
              `refs/tags/${input.ref}^{}`,
            ]);
            if (listed.exitCode !== 0)
              return yield* new SkillFetchFailed({ reason: "unreachable" });
            const refs = new Map(
              text(listed)
                .split("\n")
                .flatMap((line) => {
                  const [id, name] = line.split("\t");
                  return id !== undefined && name !== undefined && isCommitId(id)
                    ? [[name, id] as const]
                    : [];
                }),
            );
            // A branch, else an annotated tag's commit, else a lightweight tag's.
            const found =
              refs.get(`refs/heads/${input.ref}`) ??
              refs.get(`refs/tags/${input.ref}^{}`) ??
              refs.get(`refs/tags/${input.ref}`);
            if (found === undefined) return yield* new SkillFetchFailed({ reason: "no-ref" });
            return found;
          });

      const fetched = yield* git([
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        url.href,
        commit,
      ]);
      if (fetched.exitCode !== 0) {
        return yield* new SkillFetchFailed({
          reason: isCommitId(input.ref) ? "no-ref" : "unreachable",
        });
      }
      // The commit fetched is the one named: a server cannot answer with another.
      const kind = yield* git(["cat-file", "-t", commit]);
      if (kind.exitCode !== 0 || text(kind).trim() !== "commit") {
        return yield* new SkillFetchFailed({ reason: "no-ref" });
      }

      const prefix = input.path === "" ? "" : `${input.path}/`;
      const listing = yield* git([
        "ls-tree",
        "-r",
        "-z",
        "--long",
        commit,
        ...(prefix === "" ? [] : ["--", prefix]),
      ]);
      if (listing.truncated) return yield* new NotASkill({ reason: "it holds too many files" });
      const entries = text(listing)
        .split("\0")
        .filter((line) => line !== "")
        .map((line) => TREE_ENTRY.exec(line));
      const blobs: Array<{ readonly path: string; readonly id: string }> = [];
      let bytes = 0;
      for (const entry of entries) {
        if (entry === null) return yield* new NotASkill({ reason: "its tree could not be read" });
        const [, mode = "", type = "", id = "", size = "", full = ""] = entry;
        const inner = full.slice(prefix.length);
        if (mode === "120000") return yield* new NotASkill({ reason: `${inner} is a link` });
        if (type !== "blob") return yield* new NotASkill({ reason: `${inner} is a submodule` });
        const segments = inner.split("/");
        if (
          inner.length > SKILL_LIMITS.pathLength ||
          segments.some(
            (segment) => segment === "." || segment === ".." || segment.toLowerCase() === ".git",
          )
        ) {
          return yield* new NotASkill({ reason: `${inner} is not a path J3 Bots writes` });
        }
        bytes += Number(size);
        blobs.push({ path: inner, id });
      }
      if (!blobs.some((blob) => blob.path === SKILL_FILE)) {
        return yield* new NotASkill({
          reason: `${input.path === "" ? "its root" : input.path} holds no ${SKILL_FILE}`,
        });
      }
      if (blobs.length > SKILL_LIMITS.files + 1) {
        return yield* new NotASkill({
          reason: `it holds more than ${SKILL_LIMITS.files} files beside ${SKILL_FILE}`,
        });
      }
      if (bytes > SKILL_LIMITS.bytes) {
        return yield* new NotASkill({
          reason: `it is larger than ${SKILL_LIMITS.bytes / 1024 / 1024} MiB`,
        });
      }

      const files = yield* Effect.forEach(blobs, ({ path, id }) =>
        Effect.map(git(["cat-file", "blob", id], SKILL_LIMITS.bytes), (ran) => ({
          path,
          data: ran.output,
        })),
      );
      const skillFile = files.find((file) => file.path === SKILL_FILE);
      if (skillFile !== undefined) {
        yield* Effect.try({
          try: () => decoder.decode(skillFile.data),
          catch: () => new NotASkill({ reason: `its ${SKILL_FILE} is not UTF-8 text` }),
        });
      }
      const result: FetchedSkill = { commit, files };
      return result;
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: FETCH_WITHIN,
      orElse: () => Effect.fail(new SkillFetchFailed({ reason: "timed-out" })),
    }),
  );

  return SkillRepositories.of({ fetch });
});

/** The fetcher J3 Bots runs: the connector guard's policy for an address the operator did not confirm. */
export const layer = Layer.effect(
  SkillRepositories,
  make({
    policy: { loopback: "refuse", privateNetwork: "refuse", redirects: "refuse" },
    resolve: DEFAULT_GUARD.resolve,
  }),
);
