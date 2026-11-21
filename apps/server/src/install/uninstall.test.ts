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

interface Machine {
  /** Where the release that runs is, under the install folder; `versions/0.1.0` by default. */
  readonly release?: ReadonlyArray<string>;
  /** The text of the command the install recorded; install.sh's own by default. */
  readonly launcher?: (install: string) => string;
  /** Whether the service is installed, and the data directory its unit names, under the scratch folder. */
  readonly unitHome: Option.Option<string>;
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
    yield* fs.makeDirectory(at("bin"));
    yield* fs.writeFileString(
      launcher,
      machine.launcher?.(install) ??
        `#!/bin/sh\n# J3 Bots, installed by install.sh.\nexec '${install}/versions/0.1.0/bin/j3-bots' "$@"\n`,
    );
    yield* fs.writeFileString(path.join(install, "launcher"), `${launcher}\n`);
    for (const home of [at("data"), at("other-data")]) {
      yield* fs.makeDirectory(path.join(home, "bots"), { recursive: true });
    }
    if (Option.isSome(machine.unitHome)) {
      yield* fs.makeDirectory(path.dirname(unitFile), { recursive: true });
      yield* fs.writeFileString(
        unitFile,
        `[Service]\nEnvironment=J3_HOME=${at(machine.unitHome.value)}\n`,
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
    };
  }).pipe(Effect.scoped);

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

it.layer(NodeServices.layer)("uninstall", (it) => {
  it.effect("removes the service, the command and every version, and keeps the data", () =>
    Effect.gen(function* () {
      const { exit, calls, left } = yield* uninstallOn(
        { unitHome: Option.some("data") },
        { deleteData: false },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) {
        assert.isTrue(exit.value.serviceRemoved);
        assert.isFalse(exit.value.dataDeleted);
      }
      assert.deepStrictEqual(calls, ["disable and stop j3-bots.service", "reload"]);
      assert.deepStrictEqual(left, {
        unit: false,
        launcher: false,
        install: false,
        data: true,
        otherData: true,
      });
    }),
  );

  it.effect("deletes the data directory the service ran with, not this shell's", () =>
    Effect.gen(function* () {
      const { exit, left } = yield* uninstallOn(
        { unitHome: Option.some("data"), shellHome: "other-data" },
        { deleteData: true },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
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

  it.effect("keeps a command at the recorded path that install.sh did not write", () =>
    Effect.gen(function* () {
      const { exit, left } = yield* uninstallOn(
        {
          unitHome: Option.none(),
          // Someone else's wrapper, though it runs one of the versions.
          launcher: (install) =>
            `#!/bin/sh\nexport J3_PORT=4000\nexec '${install}/versions/0.1.0/bin/j3-bots' "$@"\n`,
        },
        { deleteData: false },
      );
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      if (Exit.isSuccess(exit)) {
        assert.deepStrictEqual(
          Option.map(exit.value.launcher, ({ removed }) => removed),
          Option.some(false),
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
      assert.deepInclude(failure(exit), { _tag: "UninstallRefused", reason: "server-outside" });
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

  it.effect("never deletes a data directory that is or holds the user's home", () =>
    Effect.gen(function* () {
      const { exit, left } = yield* uninstallOn(
        { unitHome: Option.none(), shellHome: "." },
        { deleteData: true },
      );
      assert.deepInclude(failure(exit), { _tag: "UninstallRefused", reason: "user-home" });
      assert.isTrue(left.install);
      assert.isTrue(left.data);
    }),
  );

  it.effect("removes nothing from a release that install.sh did not install", () =>
    Effect.gen(function* () {
      const { exit, left } = yield* uninstallOn(
        { unitHome: Option.some("data"), release: ["unpacked", "j3-bots-0.1.0-linux-x64"] },
        { deleteData: true },
      );
      assert.deepInclude(failure(exit), { _tag: "UninstallRefused", reason: "unpacked" });
      assert.isTrue(left.unit);
      assert.isTrue(left.install);
      assert.isTrue(left.data);
    }),
  );
});
