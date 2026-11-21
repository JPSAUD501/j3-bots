// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AdminClient } from "../admin/AdminClient.ts";
import { AdminStatus } from "../admin/protocol.ts";
import type { Installation } from "../installation.ts";
import { Host } from "../system/Host.ts";
import { Systemd } from "../system/Systemd.ts";
import { plan, uninstall } from "./uninstall.ts";

/** A server that answers on the admin socket, from a process that is not the service's. */
const outsider = Schema.decodeSync(Schema.toCodecJson(AdminStatus))({
  version: "0.1.0",
  pid: 999,
  startedAt: "2026-11-20T08:00:00.000Z",
  listener: { scheme: "http", address: "127.0.0.1", port: 3737, names: [] },
  toolPort: 3739,
  enginePort: 3738,
  engine: { state: { _tag: "starting" }, pinnedVersion: "0.1.11", providers: [] },
  pairedDevices: 0,
  webClient: "served",
});

/** The text install.sh writes for the command that runs the release at `release`. */
const ownLauncher = (release: string) =>
  `#!/bin/sh\n# J3 Bots, installed by install.sh. \`j3-bots uninstall\` removes it.\nexec '${release}/bin/j3-bots' "$@"\n`;

interface Machine {
  /** Where the release that runs is, under the install folder; `versions/0.1.0` by default. */
  readonly release?: ReadonlyArray<string>;
  /** Whether install.sh recorded its command in the install folder; it did by default. */
  readonly recorded?: boolean;
  /** The text of the command the install recorded, install.sh's own by default; none for no command. */
  readonly launcher?: (install: string) => Option.Option<string>;
  /** Files of the user's, by path under the scratch folder; a path ending in `/` is a folder. */
  readonly userFiles?: ReadonlyArray<string>;
  /** Whether the data directory `data` is a link to the folder `linked-data`. */
  readonly dataIsLink?: boolean;
  /** Whether the service is installed, and the data directory its unit names, under the scratch folder. */
  readonly unitHome: Option.Option<string>;
  /** What the service's unit starts: this install's release (by default), or a checkout's server. */
  readonly unitRuns?: "this install" | "a checkout";
  /** `J3_HOME` in this shell, relative to the scratch folder. */
  readonly shellHome?: string;
  /** What answers on the admin socket. */
  readonly answering?: Option.Option<AdminStatus>;
}

/** A host as install.sh leaves it, with a fake systemd; what an uninstall does there. */
const uninstallOn = (machine: Machine, options: { readonly deleteData: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
    const install = at("share", "j3-bots");
    const launcher = at("bin", "j3-bots");
    const configHome = at("config");
    const unitFile = path.join(configHome, "systemd", "user", "j3-bots.service");

    const releaseRoot = path.join(install, ...(machine.release ?? ["versions", "0.1.0"]));
    for (const version of [releaseRoot, path.join(install, "versions", "0.0.9")]) {
      yield* fs.makeDirectory(path.join(version, "bin"), { recursive: true });
      yield* fs.writeFileString(path.join(version, "release.json"), "{}");
    }
    // What an interrupted install.sh leaves: a staging folder.
    yield* fs.makeDirectory(path.join(install, "versions", ".staging-a1B2c3", "j3-bots"), {
      recursive: true,
    });
    yield* fs.makeDirectory(at("bin"));
    const launcherText =
      machine.launcher?.(install) ??
      Option.some(ownLauncher(path.join(install, "versions", "0.1.0")));
    if (Option.isSome(launcherText)) yield* fs.writeFileString(launcher, launcherText.value);
    if (machine.recorded ?? true) {
      yield* fs.writeFileString(path.join(install, "launcher"), `${launcher}\n`);
    }
    const dataHomes = [
      machine.dataIsLink === true ? at("linked-data") : at("data"),
      at("other-data"),
    ];
    for (const home of dataHomes) {
      yield* fs.makeDirectory(path.join(home, "bots"), { recursive: true });
      yield* fs.writeFileString(path.join(home, "j3.sqlite"), "");
      yield* fs.writeFileString(path.join(home, "j3.sqlite-wal"), "");
    }
    if (machine.dataIsLink === true) yield* fs.symlink(at("linked-data"), at("data"));
    for (const file of machine.userFiles ?? []) {
      if (file.endsWith("/")) {
        yield* fs.makeDirectory(at(file), { recursive: true });
      } else {
        yield* fs.makeDirectory(path.dirname(at(file)), { recursive: true });
        yield* fs.writeFileString(at(file), "mine");
      }
    }
    if (Option.isSome(machine.unitHome)) {
      yield* fs.makeDirectory(path.dirname(unitFile), { recursive: true });
      // What `service install` writes: the release's Node, or the checkout's, and its entry point.
      const execStart =
        (machine.unitRuns ?? "this install") === "this install"
          ? `${releaseRoot}/node/bin/node ${releaseRoot}/server/bin.mjs serve`
          : `/usr/bin/node ${at("checkout", "apps", "server", "src", "bin.ts")} serve`;
      yield* fs.writeFileString(
        unitFile,
        `[Service]\nEnvironment=J3_HOME=${at(machine.unitHome.value)}\nExecStart=${execStart}\n`,
      );
    }

    const calls: Array<string> = [];
    const fakes = Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          HOME: root,
          J3_HOME: at(machine.shellHome ?? "data"),
          XDG_CONFIG_HOME: configHome,
        }),
      ),
      Layer.succeed(
        Host,
        Host.of({
          nodeVersion: "26.13.1",
          platform: "linux",
          arch: "x64",
          totalMemoryBytes: 4 * 1024 ** 3,
          userName: "bots",
          searchPath: "/usr/bin",
          freeSpace: () => Effect.succeedNone,
          portState: () => Effect.succeed({ _tag: "free" }),
          findExecutable: () => Effect.succeedNone,
          holdsSocket: () => Effect.succeedSome(false),
          sshPrivateKeys: Effect.succeed([]),
          groups: Effect.succeed([]),
          reachable: () => Effect.die("uninstall never downloads"),
        }),
      ),
      Layer.succeed(
        AdminClient,
        AdminClient.of({
          status: () => Effect.succeed(machine.answering ?? Option.none()),
          startPairing: () => Effect.die("uninstall never pairs"),
          connectProviders: () => Effect.die("uninstall never connects providers"),
        }),
      ),
      Layer.succeed(
        Systemd,
        Systemd.of({
          available: Effect.succeed(true),
          booted: Effect.succeed(true),
          linger: Effect.succeed("yes"),
          unitState: () =>
            Effect.succeed({ enabled: false, active: "inactive", mainPid: Option.none() }),
          memoryControllerDelegated: Effect.succeed(true),
          reload: Effect.sync(() => {
            calls.push("reload");
          }),
          enableAndRestart: () => Effect.die("uninstall never starts the service"),
          disableAndStop: (unit) =>
            Effect.sync(() => {
              calls.push(`disable and stop ${unit}`);
            }),
        }),
      ),
    );
    const installation: Installation = {
      layout: {
        _tag: "release",
        root: releaseRoot,
        manifest: { version: "0.1.0", platform: "linux-x64", node: "26.13.1" },
      },
      entryPoint: path.join(releaseRoot, "server", "bin.mjs"),
      bridgeEntryPoint: path.join(releaseRoot, "server", "bridge.mjs"),
      webClient: path.join(releaseRoot, "web"),
    };
    const exit = yield* plan(installation).pipe(
      Effect.flatMap((found) => uninstall(found, options)),
      Effect.provide(fakes),
      Effect.exit,
    );
    const exists = (...parts: ReadonlyArray<string>) => fs.exists(at(...parts));
    const userFiles: Record<string, boolean> = {};
    for (const file of machine.userFiles ?? []) userFiles[file] = yield* exists(file);
    return {
      exit,
      calls,
      left: {
        unit: yield* fs.exists(unitFile),
        launcher: yield* fs.exists(launcher),
        install: yield* fs.exists(install),
        data: yield* exists("data"),
        otherData: yield* exists("other-data"),
      },
      /** Whether each of the user's files is still there. */
      userFiles,
      /** What is left in the install folder and in the data directory, by name. */
      inInstall: yield* listed(fs, install),
      inVersions: yield* listed(fs, path.join(install, "versions")),
      inData: yield* listed(fs, at("data")),
    };
  }).pipe(Effect.scoped);

/** The names in `folder`, sorted; none when it is gone. */
const listed = (fs: FileSystem.FileSystem, folder: string) =>
  fs.readDirectory(folder).pipe(
    Effect.map((names) => names.toSorted()),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

it.layer(NodeServices.layer)("uninstall", (it) => {
  it.effect("removes the service, the command and every version, and keeps the data", () =>
    Effect.gen(function* () {
      const { exit, calls, left, inData } = yield* uninstallOn(
        { unitHome: Option.some("data") },
        { deleteData: false },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) {
        assert.isTrue(exit.value.serviceRemoved);
        assert.isTrue(Option.isNone(exit.value.data));
      }
      assert.deepStrictEqual(calls, ["disable and stop j3-bots.service", "reload"]);
      assert.deepStrictEqual(left, {
        unit: false,
        launcher: false,
        install: false,
        data: true,
        otherData: true,
      });
      assert.deepStrictEqual(inData, ["bots", "j3.sqlite", "j3.sqlite-wal"]);
    }),
  );

  it.effect("deletes the data directory the service ran with, not this shell's", () =>
    Effect.gen(function* () {
      const { exit, left } = yield* uninstallOn(
        { unitHome: Option.some("data"), shellHome: "other-data" },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value.data, Option.some("deleted"));
      assert.isFalse(left.data);
      assert.isTrue(left.otherData);
      assert.isFalse(left.install);
    }),
  );

  it.effect("without the service, deletes this shell's data directory", () =>
    Effect.gen(function* () {
      const { exit, calls, left } = yield* uninstallOn(
        { unitHome: Option.none() },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      assert.deepStrictEqual(calls, []);
      assert.isFalse(left.data);
      assert.isFalse(left.launcher);
      assert.isFalse(left.install);
    }),
  );

  it.effect("keeps the service of another J3 Bots, and the data it runs with", () =>
    Effect.gen(function* () {
      const { exit, calls, left } = yield* uninstallOn(
        { unitHome: Option.some("other-data"), unitRuns: "a checkout" },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) {
        assert.isFalse(exit.value.serviceRemoved);
        assert.deepStrictEqual(exit.value.data, Option.some("deleted"));
      }
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(left, {
        unit: true,
        launcher: false,
        install: false,
        data: false,
        otherData: true,
      });
    }),
  );

  it.effect("deletes nothing from a folder no server has used", () =>
    Effect.gen(function* () {
      const userFiles = ["plain/shared/", "plain/state/", "plain/config.json", "plain/notes.txt"];
      const { exit, userFiles: kept } = yield* uninstallOn(
        { unitHome: Option.none(), shellHome: "plain", userFiles },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value.data, Option.some("not-j3"));
      assert.isTrue(Object.values(kept).every(Boolean), JSON.stringify(kept));
    }),
  );

  it.effect("keeps the web client the operator put in the data directory, and the folder", () =>
    Effect.gen(function* () {
      const { exit, left, inData } = yield* uninstallOn(
        { unitHome: Option.none(), userFiles: ["data/web/index.html", "data/shared/memory/"] },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value.data, Option.some("web-kept"));
      assert.isTrue(left.data);
      assert.deepStrictEqual(inData, ["web"]);
    }),
  );

  it.effect("removes the rest when the recorded command is missing", () =>
    Effect.gen(function* () {
      const { exit, left } = yield* uninstallOn(
        { unitHome: Option.none(), launcher: () => Option.none() },
        { deleteData: false },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) {
        assert.deepStrictEqual(
          Option.map(exit.value.launcher, ({ state }) => state),
          Option.some("missing"),
        );
      }
      assert.isFalse(left.install);
    }),
  );

  it.effect("deletes only J3 Bots' entries from a data directory that holds other files", () =>
    Effect.gen(function* () {
      const { exit, left, userFiles, inData } = yield* uninstallOn(
        { unitHome: Option.none(), userFiles: ["data/notes.txt", "data/photos/"] },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value.data, Option.some("kept"));
      assert.isTrue(left.data);
      assert.deepStrictEqual(inData, ["notes.txt", "photos"]);
      assert.deepStrictEqual(userFiles, { "data/notes.txt": true, "data/photos/": true });
    }),
  );

  it.effect("through a data directory that is a link, deletes the entries and keeps the link", () =>
    Effect.gen(function* () {
      const { exit, left, inData } = yield* uninstallOn(
        { unitHome: Option.none(), dataIsLink: true },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value.data, Option.some("link-kept"));
      assert.isTrue(left.data);
      assert.deepStrictEqual(inData, []);
    }),
  );

  it.effect("keeps what install.sh did not put in the install folder", () =>
    Effect.gen(function* () {
      const { exit, left, userFiles, inInstall, inVersions } = yield* uninstallOn(
        {
          unitHome: Option.none(),
          userFiles: [
            "share/j3-bots/versions/notes.txt",
            "share/j3-bots/versions/mine/",
            "share/j3-bots/backup.tar",
          ],
        },
        { deleteData: false },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) assert.isFalse(exit.value.installRemoved);
      assert.isFalse(left.launcher);
      assert.deepStrictEqual(inInstall, ["backup.tar", "versions"]);
      assert.deepStrictEqual(inVersions, ["mine", "notes.txt"]);
      assert.isTrue(Object.values(userFiles).every(Boolean), JSON.stringify(userFiles));
    }),
  );

  it.effect("keeps a command at the recorded path that install.sh did not write", () =>
    Effect.gen(function* () {
      const { exit, left } = yield* uninstallOn(
        {
          unitHome: Option.none(),
          // The user's own wrapper: install.sh's three lines but for the comment.
          launcher: (install) =>
            Option.some(
              `#!/bin/sh\n# My J3 Bots.\nexec '${install}/versions/0.1.0/bin/j3-bots' "$@"\n`,
            ),
        },
        { deleteData: false },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) {
        assert.deepStrictEqual(
          Option.map(exit.value.launcher, ({ state }) => state),
          Option.some("kept"),
        );
      }
      assert.isTrue(left.launcher);
      assert.isFalse(left.install);
    }),
  );

  it.effect("removes nothing while a server outside the service holds the data to delete", () =>
    Effect.gen(function* () {
      const { exit, calls, left } = yield* uninstallOn(
        { unitHome: Option.some("data"), answering: Option.some(outsider) },
        { deleteData: true },
      );
      assert.deepInclude(failure(exit), { _tag: "UninstallRefused", reason: "server-running" });
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(left, {
        unit: true,
        launcher: true,
        install: true,
        data: true,
        otherData: true,
      });
    }),
  );

  it.effect(
    "removes nothing from a release in a versions folder that install.sh did not record",
    () =>
      Effect.gen(function* () {
        const { exit, left, userFiles, inVersions } = yield* uninstallOn(
          {
            unitHome: Option.some("data"),
            release: ["versions", "j3-bots-0.1.0-linux-x64"],
            recorded: false,
            userFiles: ["share/j3-bots/versions/notes.txt"],
          },
          { deleteData: true },
        );
        assert.deepInclude(failure(exit), { _tag: "UninstallRefused", reason: "unpacked" });
        assert.isTrue(left.unit);
        assert.isTrue(left.data);
        assert.deepStrictEqual(inVersions, [
          ".staging-a1B2c3",
          "0.0.9",
          "j3-bots-0.1.0-linux-x64",
          "notes.txt",
        ]);
        assert.deepStrictEqual(userFiles, { "share/j3-bots/versions/notes.txt": true });
      }),
  );
});
