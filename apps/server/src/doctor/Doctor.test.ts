// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AdminClient, AdminRequestFailed } from "../admin/AdminClient.ts";
import { AdminStatus } from "../admin/protocol.ts";
import { Host, type PortState } from "../system/Host.ts";
import { Network } from "../system/Network.ts";
import { type Linger, Systemd, type UnitState } from "../system/Systemd.ts";
import { type Check, type CheckStatus, diagnose } from "./Doctor.ts";

const GIB = 1024 ** 3;

const provider = (harness: "claude-code" | "codex", status: string) => ({
  id: harness,
  name: harness === "codex" ? "Codex" : "Claude Code",
  harness,
  status: { _tag: status, ...(status === "limited" ? { resetsAt: null } : {}) },
  models: [],
  usage: [],
});

/** What the running server says of itself, decoded as the CLI decodes it. */
const running = (overrides: { engine?: object; pairedDevices?: number } = {}) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(AdminStatus))({
    version: "0.0.0",
    startedAt: "2026-11-20T08:00:00.000Z",
    engine: {
      state: { _tag: "ready" },
      pinnedVersion: "0.1.11",
      providers: [provider("claude-code", "ready"), provider("codex", "ready")],
    },
    pairedDevices: 1,
    webClient: "served",
    ...overrides,
  });

/** A machine, a server and a service manager in a healthy state, unless a test changes one. */
interface World {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly freeBytes: Option.Option<number>;
  readonly ports: (host: string, port: number) => PortState;
  readonly executables: ReadonlyArray<string>;
  readonly server: Option.Option<AdminStatus> | "broken";
  readonly systemd: boolean;
  readonly unitInstalled: boolean;
  readonly unit: UnitState;
  readonly linger: Linger;
  readonly memoryDelegated: boolean;
  readonly configFile: Option.Option<string>;
  readonly homeMode: number;
}

const HEALTHY: World = {
  nodeVersion: "26.13.1",
  platform: "linux",
  freeBytes: Option.some(20 * GIB),
  ports: () => "free",
  executables: ["claude", "codex"],
  server: Option.some(running()),
  systemd: true,
  unitInstalled: true,
  unit: { enabled: true, active: "active" },
  linger: "yes",
  memoryDelegated: true,
  configFile: Option.none(),
  homeMode: 0o700,
};

const diagnoseIn = (changes: Partial<World> = {}) =>
  Effect.gen(function* () {
    const world = { ...HEALTHY, ...changes };
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const home = path.join(root, "home");
    const web = path.join(root, "web");
    const configHome = path.join(root, "config");
    yield* fs.makeDirectory(home, { mode: world.homeMode });
    yield* fs.chmod(home, world.homeMode);
    yield* fs.makeDirectory(web);
    yield* fs.writeFileString(path.join(web, "index.html"), "<!doctype html>");
    if (Option.isSome(world.configFile)) {
      yield* fs.writeFileString(path.join(home, "config.json"), world.configFile.value);
    }
    if (world.unitInstalled) {
      yield* fs.makeDirectory(path.join(configHome, "systemd", "user"), { recursive: true });
      yield* fs.writeFileString(path.join(configHome, "systemd", "user", "j3-bots.service"), "");
    }

    const fakes = Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          HOME: root,
          J3_HOME: home,
          J3_WEB_CLIENT: web,
          XDG_CONFIG_HOME: configHome,
        }),
      ),
      Layer.succeed(
        Network,
        Network.of({
          ipv4Addresses: Effect.succeed([{ address: "192.168.1.20", internal: false }]),
        }),
      ),
      Layer.succeed(
        Host,
        Host.of({
          nodeVersion: world.nodeVersion,
          platform: world.platform,
          arch: "arm64",
          totalMemoryBytes: 4 * GIB,
          userName: "pi",
          searchPath: "/usr/bin",
          freeSpace: () => Effect.succeed(world.freeBytes),
          portState: (host, port) => Effect.succeed(world.ports(host, port)),
          findExecutable: (name) =>
            Effect.succeed(
              world.executables.includes(name) ? Option.some(`/usr/bin/${name}`) : Option.none(),
            ),
        }),
      ),
      Layer.succeed(
        AdminClient,
        AdminClient.of({
          status: () =>
            world.server === "broken"
              ? Effect.fail(new AdminRequestFailed({ path: "/status" }))
              : Effect.succeed(world.server),
          startPairing: () => Effect.die("doctor never pairs"),
        }),
      ),
      Layer.succeed(
        Systemd,
        Systemd.of({
          available: Effect.succeed(world.systemd),
          linger: Effect.succeed(world.linger),
          unitState: () => Effect.succeed(world.unit),
          memoryControllerDelegated: Effect.succeed(world.memoryDelegated),
          reload: Effect.die("doctor changes nothing"),
          enableAndRestart: () => Effect.die("doctor changes nothing"),
          disableAndStop: () => Effect.die("doctor changes nothing"),
        }),
      ),
    );
    const checks = yield* diagnose.pipe(Effect.provide(fakes));
    return { checks, home };
  }).pipe(Effect.scoped);

const named = (checks: ReadonlyArray<Check>, name: string) => {
  const found = checks.find((check) => check.name === name);
  assert.isDefined(found, `no ${name} check`);
  return (
    found ?? { name, status: "skipped" satisfies CheckStatus, summary: "", fix: Option.none() }
  );
};

/** A check that found something wrong says how to fix it. */
const assertFlagged = (check: Check, status: "warning" | "problem", mentions?: string) => {
  assert.strictEqual(check.status, status, `${check.name}: ${check.summary}`);
  assert.isTrue(Option.isSome(check.fix), `${check.name} gives no fix`);
  if (mentions !== undefined) assert.include(check.summary, mentions);
};

it.layer(NodeServices.layer)("doctor", (it) => {
  it.effect("finds nothing to fix on a machine that has everything", () =>
    Effect.gen(function* () {
      const { checks } = yield* diagnoseIn();
      const flagged = checks.filter((check) => check.status !== "ok");
      assert.deepStrictEqual(
        flagged.map((check) => `${check.name}: ${check.summary}`),
        [],
      );
    }),
  );

  it.effect("checks the Node release", () =>
    Effect.gen(function* () {
      assertFlagged(
        named((yield* diagnoseIn({ nodeVersion: "24.22.2" })).checks, "Node"),
        "problem",
      );
      assert.strictEqual(
        named((yield* diagnoseIn({ nodeVersion: "26.2.0" })).checks, "Node").status,
        "ok",
      );
    }),
  );

  it.effect("checks the configuration file, and still checks the service when it is broken", () =>
    Effect.gen(function* () {
      const { checks } = yield* diagnoseIn({ configFile: Option.some('{ "prot": 3737 }') });
      assertFlagged(named(checks, "Configuration"), "problem", "config.json");
      assert.strictEqual(named(checks, "Service").status, "ok");
    }),
  );

  it.effect("checks who can read the data directory", () =>
    Effect.gen(function* () {
      assertFlagged(
        named((yield* diagnoseIn({ homeMode: 0o755 })).checks, "Data directory"),
        "warning",
      );
    }),
  );

  it.effect("checks the free disk space", () =>
    Effect.gen(function* () {
      const tight = yield* diagnoseIn({ freeBytes: Option.some(0.5 * GIB) });
      assertFlagged(named(tight.checks, "Disk space"), "problem");
      const low = yield* diagnoseIn({ freeBytes: Option.some(2 * GIB) });
      assertFlagged(named(low.checks, "Disk space"), "warning");
    }),
  );

  it.effect("checks the ports when no server holds them", () =>
    Effect.gen(function* () {
      const taken = yield* diagnoseIn({
        server: Option.none(),
        ports: (_host, port) => (port === 3739 ? "in-use" : "free"),
      });
      assertFlagged(named(taken.checks, "Ports"), "problem", "3739");
      const elsewhere = yield* diagnoseIn({ server: Option.none(), ports: () => "not-local" });
      assertFlagged(named(elsewhere.checks, "Ports"), "problem");
      // The running server's own ports are not a conflict.
      const held = yield* diagnoseIn({ ports: () => "in-use" });
      assert.strictEqual(named(held.checks, "Ports").status, "ok");
    }),
  );

  it.effect("checks the engine install and that the running engine is the pinned one", () =>
    Effect.gen(function* () {
      const notInstalled = yield* diagnoseIn({ server: Option.none() });
      assertFlagged(named(notInstalled.checks, "Engine"), "warning");
      const unsupported = yield* diagnoseIn({ server: Option.none(), platform: "win32" });
      assertFlagged(named(unsupported.checks, "Engine"), "problem", "win32");

      const other = yield* diagnoseIn({
        server: Option.some(
          running({
            engine: {
              state: { _tag: "incompatible", runningVersion: "0.1.9" },
              pinnedVersion: "0.1.11",
              providers: [],
            },
          }),
        ),
      });
      assertFlagged(named(other.checks, "Engine"), "problem", "0.1.9");
      const failed = yield* diagnoseIn({
        server: Option.some(
          running({
            engine: {
              state: { _tag: "unavailable", reason: "install-failed" },
              pinnedVersion: "0.1.11",
              providers: [],
            },
          }),
        ),
      });
      assertFlagged(named(failed.checks, "Engine"), "problem");
    }),
  );

  it.effect("checks each harness is found and signed in, from the engine's provider status", () =>
    Effect.gen(function* () {
      const missing = yield* diagnoseIn({ executables: ["codex"] });
      assertFlagged(named(missing.checks, "Claude Code"), "warning", "claude");
      assert.strictEqual(named(missing.checks, "Codex").status, "ok");

      const signedOut = yield* diagnoseIn({
        server: Option.some(
          running({
            engine: {
              state: { _tag: "ready" },
              pinnedVersion: "0.1.11",
              providers: [provider("claude-code", "sign-in-required")],
            },
          }),
        ),
      });
      assertFlagged(named(signedOut.checks, "Claude Code"), "problem");
      // Found, but the server runs no Codex provider at all.
      assertFlagged(named(signedOut.checks, "Codex"), "warning", "no Codex provider");
    }),
  );

  it.effect("checks whether a device is paired, which only the running server knows", () =>
    Effect.gen(function* () {
      const none = yield* diagnoseIn({ server: Option.some(running({ pairedDevices: 0 })) });
      assertFlagged(named(none.checks, "Pairing"), "warning");
      const stopped = yield* diagnoseIn({ server: Option.none() });
      assert.strictEqual(named(stopped.checks, "Pairing").status, "skipped");
      assertFlagged(named(stopped.checks, "Server"), "warning");
      const broken = yield* diagnoseIn({ server: "broken" });
      assertFlagged(named(broken.checks, "Server"), "problem");
    }),
  );

  it.effect("checks the service, lingering and the memory limit", () =>
    Effect.gen(function* () {
      const absent = yield* diagnoseIn({ unitInstalled: false });
      assertFlagged(named(absent.checks, "Service"), "warning");
      const failed = yield* diagnoseIn({ unit: { enabled: true, active: "failed" } });
      assertFlagged(named(failed.checks, "Service"), "problem");
      const disabled = yield* diagnoseIn({ unit: { enabled: false, active: "active" } });
      assertFlagged(named(disabled.checks, "Service"), "warning");

      const noLinger = yield* diagnoseIn({ linger: "no" });
      assertFlagged(named(noLinger.checks, "Start at boot"), "warning");
      assert.include(
        Option.getOrElse(named(noLinger.checks, "Start at boot").fix, () => ""),
        "enable-linger",
      );

      const unlimited = yield* diagnoseIn({ memoryDelegated: false });
      assertFlagged(named(unlimited.checks, "Memory limit"), "warning");

      const noManager = yield* diagnoseIn({ systemd: false });
      assertFlagged(named(noManager.checks, "Service"), "warning");
    }),
  );
});
