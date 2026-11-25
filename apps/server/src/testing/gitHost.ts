// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the fake host is git's own CGI program behind node:http, and its repository is written with git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_GUARD } from "@j3-bots/connectors";
import { make, SkillRepositories } from "../skills/SkillRepositories.ts";

/** A git host on this machine's loopback, serving one repository over plain HTTP. */
export interface FakeGitHost {
  /** The repository's address, as a bot names it: {@link REPOSITORY}. */
  readonly url: string;
  /**
   * Commits `files` (by path, a file's text or a link's target) on top of
   * what is there, on `main`, and answers the commit's id.
   */
  readonly commit: (files: Readonly<Record<string, string | { readonly link: string }>>) => string;
  /** Tags the last commit. */
  readonly tag: (name: string) => void;
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();

/** Answers one request with `git http-backend`, which reads it as CGI. */
const serve = (
  root: string,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
) => {
  const url = new URL(request.url ?? "/", "http://fake");
  const backend = NodeChildProcess.spawn("git", ["http-backend"], {
    env: {
      PATH: process.env["PATH"] ?? "",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
      HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"] ?? ""),
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  request.pipe(backend.stdin);
  let head = Buffer.alloc(0);
  let started = false;
  backend.stdout.on("data", (chunk: Buffer) => {
    if (started) {
      response.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    started = true;
    for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
      const at = line.indexOf(":");
      const name = line.slice(0, at);
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") response.statusCode = Number.parseInt(value, 10);
      else response.setHeader(name, value);
    }
    response.write(head.subarray(end + 4));
  });
  backend.stdout.on("end", () => response.end());
};

/** A fake git host for the scope, with an empty repository `skills.git`. */
export const fakeGitHost = Effect.acquireRelease(
  Effect.callback<{
    readonly host: FakeGitHost;
    readonly served: string;
    readonly close: () => void;
  }>((resume) => {
    const root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "j3-git-host-"));
    const bare = NodePath.join(root, "skills.git");
    const work = NodePath.join(root, "work");
    NodeFs.mkdirSync(work);
    git(root, ["init", "--quiet", "--bare", bare]);
    git(work, ["init", "--quiet", "--initial-branch", "main"]);
    const server = NodeHttp.createServer((request, response) => serve(root, request, response));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const host: FakeGitHost = {
        url: REPOSITORY,
        commit: (files) => {
          for (const [file, content] of Object.entries(files)) {
            const at = NodePath.join(work, file);
            NodeFs.rmSync(at, { force: true });
            NodeFs.mkdirSync(NodePath.dirname(at), { recursive: true });
            if (typeof content === "string") NodeFs.writeFileSync(at, content);
            else NodeFs.symlinkSync(content.link, at);
          }
          git(work, ["add", "--all"]);
          git(work, ["commit", "--quiet", "--message", "skills"]);
          git(work, ["push", "--quiet", "--force", bare, "HEAD:refs/heads/main", "--tags"]);
          return git(work, ["rev-parse", "HEAD"]);
        },
        tag: (name) => {
          git(work, ["tag", name]);
          git(work, ["push", "--quiet", bare, `refs/tags/${name}`]);
        },
      };
      resume(
        Effect.succeed({
          host,
          served: `http://127.0.0.1:${port}/skills.git`,
          close: () => {
            server.close();
            NodeFs.rmSync(root, { recursive: true, force: true });
          },
        }),
      );
    });
  }),
  ({ close }) => Effect.sync(close),
);

/** The public address skills are installed from in tests, which reaches the fake host. */
export const REPOSITORY = "https://git.example.test/skills.git";

/** The fake git host of a test's domain. */
export class TestGitHost extends Context.Service<TestGitHost, FakeGitHost>()(
  "@j3-bots/server/testing/gitHost/TestGitHost",
) {}

/**
 * A fake git host for the layer's scope, and the server's own git fetcher,
 * which reaches it when a skill is installed from {@link REPOSITORY}: the
 * fetcher is let reach this machine's loopback over plain HTTP, which only
 * tests allow, and is pointed at the host, as a connector test points a
 * connector's sealed address at its fake server.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { host, served } = yield* fakeGitHost;
    const real = yield* make({
      policy: { loopback: "allow-http", privateNetwork: "refuse", redirects: "refuse" },
      resolve: DEFAULT_GUARD.resolve,
    });
    return Layer.merge(
      Layer.succeed(TestGitHost, host),
      Layer.succeed(
        SkillRepositories,
        SkillRepositories.of({
          fetch: (input) =>
            real.fetch({
              ...input,
              repository: input.repository === REPOSITORY ? served : input.repository,
            }),
        }),
      ),
    );
  }),
).pipe(Layer.provide(NodeServices.layer));
