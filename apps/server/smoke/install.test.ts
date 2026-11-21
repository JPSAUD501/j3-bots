// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the mirror is a node:http server, and its SHA256SUMS is made with node:crypto.
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
// GitHub release that holds the archive `pnpm release` built: the archive is
// checked against SHA256SUMS and installed, and `j3-bots uninstall
// --delete-data` takes everything away again. The service is left out
// (`--no-service`): a CI runner has no systemd user manager to run it in.
// Needs the archive in J3_RELEASE_ARCHIVE.

const INSTALL_SCRIPT = `${import.meta.dirname}/../../../scripts/install.sh`;

/** A mirror of a release page, `J3_RELEASE_BASE_URL`, serving `files` by path and noting each path asked for. */
const mirror = (files: ReadonlyMap<string, Uint8Array>) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly served: Array<string>; close: () => void }>(
      (resume) => {
        const served: Array<string> = [];
        const server = NodeHttp.createServer((request, response) => {
          const path = request.url ?? "/";
          served.push(path);
          const body = files.get(path);
          if (body === undefined) {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, { "content-length": body.byteLength });
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
    const scratch = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "j3-install-" }),
    );
    const home = path.join(scratch, "home");
    yield* fs.makeDirectory(home);
    return {
      fs,
      path,
      env: {
        PATH: yield* searchPathWithoutNode(path.join(scratch, "commands"), replaced),
        HOME: home,
        LANG: "C.UTF-8",
      },
      /** The folders install.sh puts things in by default. */
      install: path.join(home, ".local", "share", "j3-bots"),
      launcher: path.join(home, ".local", "bin", "j3-bots"),
      data: path.join(home, ".j3-bots"),
    };
  });

/** The archive `pnpm release` built, and the version its name says. */
const releaseArchive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = yield* Config.String("J3_RELEASE_ARCHIVE");
  const name = path.basename(archive);
  const version = /^j3-bots-(.+)-linux-(x64|arm64)\.tar\.gz$/.exec(name)?.[1];
  if (version === undefined) return yield* Effect.die(`${archive} is not a release archive.`);
  return { name, version, bytes: yield* fs.readFile(archive) };
});

const encoded = (text: string) => new TextEncoder().encode(text);

/** One release on a release page, `version`, with its archive and its SHA256SUMS. */
const releaseFiles = (
  version: string,
  archive: string,
  bytes: Uint8Array,
  digest = sha256(bytes),
) =>
  new Map<string, Uint8Array>([
    [`/download/v${version}/${archive}`, bytes],
    [`/download/v${version}/SHA256SUMS`, encoded(`${digest}  ${archive}\n`)],
  ]);

/** The answer of a release page's `latest`, asked for JSON, when `tag` is the latest release. */
const latestPage = (tag: string) => encoded(`{"id":1,"tag_name":"${tag}","update_url":"/"}`);

it.layer(NodeServices.layer, { excludeTestServices: true })("install.sh", (it) => {
  it.effect(
    "installs a release with one command, and uninstall removes it all",
    () =>
      Effect.gen(function* () {
        const host = yield* strangersHost();
        const { fs, path } = host;
        const { name, version, bytes } = yield* releaseArchive;
        const files = releaseFiles(version, name, bytes);
        files.set(
          `/download/v${version}/install.sh`,
          yield* fs.readFile(path.resolve(INSTALL_SCRIPT)),
        );
        const site = yield* mirror(files);
        const env = { ...host.env, J3_RELEASE_BASE_URL: site.url };
        // Data a stranger already has from a server that ran, which only --delete-data deletes.
        yield* fs.makeDirectory(path.join(host.data, "bots"), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(path.join(host.data, "j3.sqlite"), "");

        // By name, as a pre-release is installed: what a tag's own release notes say to run.
        const installed = yield* runToEnd(
          ChildProcess.make(
            "sh",
            [
              "-c",
              'curl -fsSL "$0" | sh -s -- --version "$1" --no-service',
              `${site.url}/download/v${version}/install.sh`,
              version,
            ],
            { env, extendEnv: false },
          ),
        );
        assert.strictEqual(installed.exitCode, 0, installed.output);
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

  it.effect("installs the release the latest page names, and never a pre-release from it", () =>
    Effect.gen(function* () {
      const host = yield* strangersHost();
      const run = (files: ReadonlyMap<string, Uint8Array>) =>
        Effect.gen(function* () {
          const site = yield* mirror(files);
          const result = yield* runToEnd(
            ChildProcess.make("sh", [host.path.resolve(INSTALL_SCRIPT), "--no-service"], {
              env: { ...host.env, J3_RELEASE_BASE_URL: site.url },
              extendEnv: false,
            }),
          );
          return { ...result, served: [...site.served] };
        });

      const stable = yield* run(new Map([["/latest", latestPage("v9.9.9")]]));
      assert.deepStrictEqual(stable.served, ["/latest", "/download/v9.9.9/SHA256SUMS"]);

      const pre = yield* run(new Map([["/latest", latestPage("v9.9.9-rc.1")]]));
      assert.notStrictEqual(pre.exitCode, 0, pre.output);
      assert.include(pre.output, "is not a stable version");
      assert.deepStrictEqual(pre.served, ["/latest"]);
      assert.isFalse(yield* host.fs.exists(host.install));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an archive that does not match SHA256SUMS, and installs nothing", () =>
    Effect.gen(function* () {
      const host = yield* strangersHost();
      const { name, version, bytes } = yield* releaseArchive;
      const site = yield* mirror(releaseFiles(version, name, bytes, sha256(encoded("other"))));
      const refused = yield* runToEnd(
        ChildProcess.make(
          "sh",
          [host.path.resolve(INSTALL_SCRIPT), "--version", `v${version}`, "--no-service"],
          { env: { ...host.env, J3_RELEASE_BASE_URL: site.url }, extendEnv: false },
        ),
      );
      assert.notStrictEqual(refused.exitCode, 0, refused.output);
      assert.include(refused.output, "does not match its checksum in SHA256SUMS");
      assert.isFalse(yield* host.fs.exists(host.install));
      assert.isFalse(yield* host.fs.exists(host.launcher));
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
          const site = yield* mirror(new Map([["/latest", latestPage("v9.9.9")]]));
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
