// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the mirror is a node:http server that can cut a download short, and its SHA256SUMS is made with node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { runToEnd, searchPathWithoutNode } from "./host.ts";

// scripts/install.sh, run as a stranger runs it, against a static mirror of a
// GitHub release that holds the archive `pnpm release` built: the latest
// release is found, a cut download resumes, the archive is checked against
// SHA256SUMS, and `j3-bots uninstall --delete-data` takes everything away
// again. The service is left out (`--no-service`): a CI runner has no systemd
// user manager to run it in. Needs the archive in J3_RELEASE_ARCHIVE.

const INSTALL_SCRIPT = `${import.meta.dirname}/../../../scripts/install.sh`;

/** One request the mirror answered. */
interface Served {
  readonly path: string;
  readonly range: string | undefined;
}

/**
 * A mirror of a release page, `J3_RELEASE_BASE_URL`, serving `files` by path:
 * ranges as GitHub's downloads do, and the first request for `cut` cut off
 * halfway, as a dropped connection would.
 */
const mirror = (files: ReadonlyMap<string, Uint8Array>, cut?: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly served: Array<Served>; close: () => void }>(
      (resume) => {
        const served: Array<Served> = [];
        let cutting = cut;
        const server = NodeHttp.createServer((request, response) => {
          const path = request.url ?? "/";
          served.push({ path, range: request.headers.range });
          const body = files.get(path);
          if (body === undefined) {
            response.writeHead(404).end();
            return;
          }
          const from = /^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1];
          if (from !== undefined) {
            const start = Number(from);
            if (start >= body.byteLength) {
              response.writeHead(416, { "content-range": `bytes */${body.byteLength}` }).end();
              return;
            }
            response.writeHead(206, {
              "content-length": body.byteLength - start,
              "content-range": `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`,
            });
            response.end(body.subarray(start));
            return;
          }
          response.writeHead(200, { "content-length": body.byteLength, "accept-ranges": "bytes" });
          if (path === cutting) {
            cutting = undefined;
            response.write(body.subarray(0, Math.floor(body.byteLength / 2)), () =>
              request.socket.destroy(),
            );
            return;
          }
          response.end(body);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = address !== null && typeof address === "object" ? address.port : 0;
          resume(
            Effect.succeed({
              url: `http://127.0.0.1:${port}`,
              served,
              close: () => server.close(),
            }),
          );
        });
      },
    ),
    (running) => Effect.sync(() => running.close()),
  );

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A stranger's machine: a home of its own, and a PATH with no Node but the release's. */
const strangersHost = (replaced: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const archive = yield* Config.String("J3_RELEASE_ARCHIVE");
    const name = path.basename(archive);
    const parts = /^j3-bots-(.+)-linux-(x64|arm64)\.tar\.gz$/.exec(name);
    if (parts?.[1] === undefined) return yield* Effect.die(`${archive} is not a release archive.`);
    const version = parts[1];
    const scratch = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "j3-install-" }),
    );
    const home = path.join(scratch, "home");
    yield* fs.makeDirectory(home);
    const env = {
      PATH: yield* searchPathWithoutNode(path.join(scratch, "commands"), replaced),
      HOME: home,
      LANG: "C.UTF-8",
    };
    return {
      fs,
      path,
      version,
      name,
      bytes: yield* fs.readFile(archive),
      home,
      env,
      /** The folders install.sh puts things in by default. */
      install: path.join(home, ".local", "share", "j3-bots"),
      launcher: path.join(home, ".local", "bin", "j3-bots"),
      data: path.join(home, ".j3-bots"),
    };
  });

/** A release page with one release, `version`, the latest. */
const releasePage = (version: string, archive: string, bytes: Uint8Array, digest = sha256(bytes)) =>
  new Map<string, Uint8Array>([
    ["/latest", new TextEncoder().encode(`{"id":1,"tag_name":"v${version}","update_url":"/"}`)],
    [`/download/v${version}/${archive}`, bytes],
    [`/download/v${version}/SHA256SUMS`, new TextEncoder().encode(`${digest}  ${archive}\n`)],
  ]);

it.layer(NodeServices.layer, { excludeTestServices: true })("install.sh", (it) => {
  it.effect(
    "installs the latest release with one command, resuming a cut download, and uninstall removes it all",
    () =>
      Effect.gen(function* () {
        const host = yield* strangersHost();
        const { fs, path, version } = host;
        const files = releasePage(version, host.name, host.bytes);
        files.set(
          `/download/v${version}/install.sh`,
          yield* fs.readFile(path.resolve(INSTALL_SCRIPT)),
        );
        const archivePath = `/download/v${version}/${host.name}`;
        const site = yield* mirror(files, archivePath);
        const env = { ...host.env, J3_RELEASE_BASE_URL: site.url };
        // Data a stranger already has, which only --delete-data deletes.
        yield* fs.makeDirectory(path.join(host.data, "bots"), { recursive: true, mode: 0o700 });

        const oneLiner = ChildProcess.make(
          "sh",
          [
            "-c",
            'curl -fsSL "$0" | sh -s -- --no-service',
            `${site.url}/download/v${version}/install.sh`,
          ],
          { env, extendEnv: false },
        );
        const cut = yield* runToEnd(oneLiner);
        assert.notStrictEqual(cut.exitCode, 0, cut.output);
        assert.include(cut.output, "Run this again: it resumes where it stopped.");
        assert.isFalse(yield* fs.exists(host.launcher));

        const installed = yield* runToEnd(oneLiner);
        assert.strictEqual(installed.exitCode, 0, installed.output);
        const resumed = site.served.filter((request) => request.path === archivePath);
        assert.strictEqual(resumed.length, 2);
        assert.match(resumed[1]?.range ?? "", /^bytes=[1-9]\d*-$/);
        // doctor ran on the release's Node, and the next steps were said.
        assert.include(installed.output, "Node 26.", installed.output);
        assert.include(installed.output, `J3 Bots ${version} is installed: ${host.launcher}`);
        assert.include(installed.output, "pair`.");
        assert.isTrue(
          yield* fs.exists(path.join(host.install, "versions", version, "release.json")),
        );
        const ran = yield* runToEnd(
          ChildProcess.make(host.launcher, ["--version"], { env, extendEnv: false }),
        );
        assert.strictEqual(ran.exitCode, 0, ran.output);
        assert.include(ran.output, version);

        const removed = yield* runToEnd(
          ChildProcess.make(host.launcher, ["uninstall", "--delete-data", "--yes"], {
            env,
            extendEnv: false,
          }),
        );
        assert.strictEqual(removed.exitCode, 0, removed.output);
        assert.isFalse(yield* fs.exists(host.launcher), removed.output);
        assert.isFalse(yield* fs.exists(host.install), removed.output);
        assert.isFalse(yield* fs.exists(host.data), removed.output);
      }).pipe(Effect.scoped),
    Duration.toMillis(Duration.minutes(3)),
  );

  it.effect("refuses an archive that does not match SHA256SUMS, and installs nothing", () =>
    Effect.gen(function* () {
      const host = yield* strangersHost();
      const { fs, path, version } = host;
      const site = yield* mirror(
        releasePage(version, host.name, host.bytes, sha256(new TextEncoder().encode("other"))),
      );
      const refused = yield* runToEnd(
        ChildProcess.make(
          "sh",
          [path.resolve(INSTALL_SCRIPT), "--version", `v${version}`, "--no-service"],
          { env: { ...host.env, J3_RELEASE_BASE_URL: site.url }, extendEnv: false },
        ),
      );
      assert.notStrictEqual(refused.exitCode, 0, refused.output);
      assert.include(refused.output, "does not match its checksum in SHA256SUMS");
      // No version, no download left over, no command.
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(host.install, "versions")), []);
      assert.isFalse(yield* fs.exists(host.launcher));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses root, other systems and a missing systemd user manager before any download",
    () =>
      Effect.gen(function* () {
        const cases = [
          { replaced: { id: "echo 0" }, args: ["--no-service"], says: "not as root" },
          {
            replaced: { uname: "echo Darwin" },
            args: ["--no-service"],
            says: "Darwin is not supported",
          },
          { replaced: { systemctl: "exit 1" }, args: [], says: "no systemd user manager" },
        ];
        for (const { replaced, args, says } of cases) {
          const host = yield* strangersHost(replaced);
          const site = yield* mirror(releasePage(host.version, host.name, host.bytes));
          const refused = yield* runToEnd(
            ChildProcess.make("sh", [host.path.resolve(INSTALL_SCRIPT), ...args], {
              env: { ...host.env, J3_RELEASE_BASE_URL: site.url },
              extendEnv: false,
            }),
          );
          assert.notStrictEqual(refused.exitCode, 0, refused.output);
          assert.include(refused.output, says);
          assert.deepStrictEqual(site.served, []);
          assert.isFalse(yield* host.fs.exists(host.install));
        }
      }).pipe(Effect.scoped),
  );
});
