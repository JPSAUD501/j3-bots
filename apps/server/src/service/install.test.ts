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
import { AdminClient, AdminRequestFailed } from "../admin/AdminClient.ts";
import { AdminStatus } from "../admin/protocol.ts";
import { Host } from "../system/Host.ts";
import { Network } from "../system/Network.ts";
import { Systemd } from "../system/Systemd.ts";
import { install } from "./install.ts";

/** The process id systemd gives the service's main process. */
const SERVICE_PID = 4242;

const answering = Schema.decodeSync(Schema.toCodecJson(AdminStatus))({
  version: "0.0.0",
  pid: SERVICE_PID,
  startedAt: "2026-11-20T08:00:00.000Z",
  listener: { scheme: "http", address: "0.0.0.0", port: 3737, names: [] },
  toolPort: 3739,
  enginePort: 3738,
  engine: { state: { _tag: "starting" }, pinnedVersion: "0.1.11", providers: [] },
  pairedDevices: 0,
  webClient: "not-built",
});

interface Machine {
  /** `config.json`, as the operator left it. */
  readonly configFile: string;
  /** Variables set in the installing shell besides the home. */
  readonly shell: Record<string, string>;
  /**
   * What answers on the admin socket before the install; `unreadable` for a
   * server that answers in other words than this release's.
   */
  readonly before: Option.Option<AdminStatus> | "unreadable";
  /** Whether the kernel says the unit's main process holds the socket, if it can say. */
  readonly holder: Option.Option<boolean>;
  /** What answers on the admin socket once the service is (re)started. */
  readonly server: Option.Option<AdminStatus>;
  /** What systemd says of the unit, before and after it was (re)started. */
  readonly active: string;
  /** Whether a plain file is where the admin socket goes. */
  readonly socketBlocked?: boolean;
}

/** Installs on a temporary home with a fake systemd; what it did, and what it returned. */
const installOn = (machine: Machine) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const unitFile = path.join(configHome, "systemd", "user", "j3-bots.service");
    yield* fs.makeDirectory(home, { mode: 0o700 });
    yield* fs.writeFileString(path.join(home, "config.json"), machine.configFile);
    if (machine.socketBlocked === true) {
      yield* fs.writeFileString(path.join(home, "admin.sock"), "not a socket");
    }
    yield* fs.makeDirectory(path.dirname(unitFile), { recursive: true });
    yield* fs.writeFileString(unitFile, "previous unit");

    const calls: Array<string> = [];
    const fakes = Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          HOME: root,
          J3_HOME: home,
          XDG_CONFIG_HOME: configHome,
          ...machine.shell,
        }),
      ),
      Layer.succeed(
        Network,
        Network.of({
          ipv4Addresses: Effect.succeed([
            { interface: "wlan0", address: "192.168.1.20", internal: false },
          ]),
        }),
      ),
      Layer.succeed(
        Host,
        Host.of({
          nodeVersion: "26.13.1",
          platform: "linux",
          arch: "arm64",
          totalMemoryBytes: 4 * 1024 ** 3,
          userName: "pi",
          searchPath: "/usr/bin",
          freeSpace: () => Effect.succeedNone,
          portState: () => Effect.succeed({ _tag: "free" }),
          findExecutable: () => Effect.succeedNone,
          holdsSocket: () => Effect.succeed(machine.holder),
        }),
      ),
      Layer.succeed(
        AdminClient,
        AdminClient.of({
          status: (socket) =>
            calls.length > 0
              ? Effect.succeed(machine.server)
              : machine.before === "unreadable"
                ? Effect.fail(new AdminRequestFailed({ path: socket, cause: "unreadable" }))
                : Effect.succeed(machine.before),
          startPairing: () => Effect.die("install never pairs"),
        }),
      ),
      Layer.succeed(
        Systemd,
        Systemd.of({
          available: Effect.succeed(true),
          linger: Effect.succeed("yes"),
          unitState: () =>
            Effect.succeed({
              enabled: true,
              active: machine.active,
              mainPid: machine.active === "active" ? Option.some(SERVICE_PID) : Option.none(),
            }),
          memoryControllerDelegated: Effect.succeed(true),
          reload: Effect.sync(() => {
            calls.push("reload");
          }),
          enableAndRestart: (unit) =>
            Effect.sync(() => {
              calls.push(`enable and restart ${unit}`);
            }),
          disableAndStop: () => Effect.die("install never stops the service"),
        }),
      ),
    );
    const exit = yield* install.pipe(Effect.provide(fakes), Effect.exit);
    return { exit, calls, unit: yield* fs.readFileString(unitFile) };
  }).pipe(Effect.scoped);

const HEALTHY: Machine = {
  configFile: "{}",
  shell: {},
  before: Option.none(),
  holder: Option.none(),
  server: Option.some(answering),
  active: "active",
};

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

it.layer(NodeServices.layer)("service install", (it) => {
  it.effect("reports success once the started server answers", () =>
    Effect.gen(function* () {
      const { exit, calls, unit } = yield* installOn({
        ...HEALTHY,
        shell: { J3_ENGINE_BINARY: "/opt/t3/bin/t3" },
      });
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit)) {
        assert.strictEqual(exit.value.server.version, "0.0.0");
        assert.deepStrictEqual(exit.value.overrides, ["J3_ENGINE_BINARY"]);
      }
      assert.deepStrictEqual(calls, ["reload", "enable and restart j3-bots.service"]);
      assert.include(unit, "ExecStart=");
    }),
  );

  it.effect("checks the configuration the service will run with, not this shell's", () =>
    Effect.gen(function* () {
      // The file gives the server the tool endpoint's port; this shell's
      // override, which the service never gets, hides that.
      const { exit, calls, unit } = yield* installOn({
        ...HEALTHY,
        configFile: JSON.stringify({ port: 3739 }),
        shell: { J3_PORT: "4000" },
      });
      assert.deepInclude(failure(exit), { _tag: "ServiceNotInstalled", reason: "configuration" });
      assert.include(failure(exit)?.toString() ?? "", "3739");
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(unit, "previous unit");
    }),
  );

  it.effect("leaves the unit as it was when a file is where the admin socket goes", () =>
    Effect.gen(function* () {
      const { exit, calls, unit } = yield* installOn({ ...HEALTHY, socketBlocked: true });
      assert.deepInclude(failure(exit), { _tag: "ServiceNotInstalled", reason: "configuration" });
      assert.include(failure(exit)?.toString() ?? "", "admin.sock.old");
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(unit, "previous unit");
    }),
  );

  it.effect("says the server failed to start instead of reporting success", () =>
    Effect.gen(function* () {
      const { exit } = yield* installOn({ ...HEALTHY, server: Option.none(), active: "failed" });
      assert.deepInclude(failure(exit), { _tag: "ServiceNotInstalled", reason: "failed" });
      // Another process answering is not the service's server coming up.
      const other = yield* installOn({
        ...HEALTHY,
        server: Option.some({ ...answering, pid: 999 }),
        active: "failed",
      });
      assert.deepInclude(failure(other.exit), { _tag: "ServiceNotInstalled", reason: "failed" });
    }),
  );

  it.effect("leaves everything as it was while another server runs for the home", () =>
    Effect.gen(function* () {
      const { exit, calls, unit } = yield* installOn({
        ...HEALTHY,
        before: Option.some({ ...answering, pid: 999 }),
        active: "inactive",
      });
      assert.deepInclude(failure(exit), {
        _tag: "ServiceNotInstalled",
        reason: "running-outside",
      });
      assert.include(failure(exit)?.toString() ?? "", "outside the service");
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(unit, "previous unit");

      // The service's own server is replaced by the restart.
      const update = yield* installOn({ ...HEALTHY, before: Option.some(answering) });
      assert.isTrue(Exit.isSuccess(update.exit));
    }),
  );

  it.effect(
    "replaces a server that answers in other words only once it is known to be the service's",
    () =>
      Effect.gen(function* () {
        // An older release run by the service: its main process holds the socket.
        const upgrade = yield* installOn({
          ...HEALTHY,
          before: "unreadable",
          holder: Option.some(true),
        });
        assert.isTrue(Exit.isSuccess(upgrade.exit));

        const outside = yield* installOn({
          ...HEALTHY,
          before: "unreadable",
          holder: Option.some(false),
        });
        assert.deepInclude(failure(outside.exit), { reason: "running-outside" });

        // The kernel cannot say which process it is: nothing is touched.
        const unknown = yield* installOn({ ...HEALTHY, before: "unreadable" });
        assert.deepInclude(failure(unknown.exit), {
          _tag: "ServiceNotInstalled",
          reason: "owner-unknown",
        });
        assert.deepStrictEqual(unknown.calls, []);
        assert.strictEqual(unknown.unit, "previous unit");
      }),
  );
});
