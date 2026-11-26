// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { runToEnd, searchPathWithoutNode } from "./host.ts";
import { releaseTag } from "@j3-bots/release";
import { latestPage, MIRROR_PUBLIC_KEY, mirror, releaseArchive, releaseFiles } from "./mirror.ts";

// scripts/install.sh, run as a stranger runs it, against a static mirror of a
// GitHub release that holds the archive `pnpm release` built: the archive is
// checked against SHA256SUMS, signed with the mirror's key, and installed, and
// `j3-bots uninstall --delete-data` takes everything away again. The service
// is left out (`--no-service`): a CI runner has no systemd user manager to run
// it in. Needs the archive in J3_RELEASE_ARCHIVE. scripts/install.test.ts
// checks the refusals of a bad signature or digest, which need no release.

const INSTALL_SCRIPT = `${import.meta.dirname}/../../../scripts/install.sh`;

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

it.layer(NodeServices.layer, { excludeTestServices: true })("install.sh", (it) => {
  it.effect(
    "installs a release with one command, and uninstall removes it all",
    () =>
      Effect.gen(function* () {
        const host = yield* strangersHost();
        const { fs, path } = host;
        const { name, version, bytes } = yield* releaseArchive("J3_RELEASE_ARCHIVE");
        const files = releaseFiles(version, name, bytes);
        files.set(
          `/download/${releaseTag(version)}/install.sh`,
          yield* fs.readFile(path.resolve(INSTALL_SCRIPT)),
        );
        const site = yield* mirror(files);
        const env = {
          ...host.env,
          J3_RELEASE_BASE_URL: site.url,
          J3_RELEASE_PUBLIC_KEY: MIRROR_PUBLIC_KEY,
        };
        // Data a stranger already has from a server that ran, which only --delete-data deletes.
        yield* fs.makeDirectory(path.join(host.data, "bots"), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(path.join(host.data, "j3.sqlite"), "");

        // By name, as a pre-release is installed: what a tag's own release notes say to run.
        // CI builds one archive as a nightly, whose tag has no `v`.
        const installed = yield* runToEnd(
          ChildProcess.make(
            "sh",
            [
              "-c",
              'curl -fsSL "$0" | sh -s -- --version "$1" --no-service',
              `${site.url}/download/${releaseTag(version)}/install.sh`,
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
