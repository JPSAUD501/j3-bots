// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { BrowserHostNeeds } from "@j3-bots/engine-t3/live";
import { AdminClient, AdminRequestFailed } from "../admin/AdminClient.ts";
import { AdminStatus } from "../admin/protocol.ts";
import { markRestoring, takeSnapshot } from "../install/snapshot.ts";
import { Host } from "../system/Host.ts";
import type { PortState } from "../system/Ports.ts";
import { Network } from "../system/Network.ts";
import { type Linger, Systemd, type UnitState } from "../system/Systemd.ts";
import { type Check, type CheckStatus, diagnose } from "./Doctor.ts";

const GIB = 1024 ** 3;

const SCRIPTED_AGENT = `${import.meta.dirname}/../../../../packages/engine-t3/scripted-agent/agent.ts`;

/** A provider as the server reports it; `checking` is unavailable while the engine's first check runs. */
const provider = (
  harness: "claude-code" | "codex",
  status: string,
  reason?: string,
  detail?: string,
) => ({
  id: harness,
  name: harness === "codex" ? "Codex" : "Claude Code",
  harness,
  status: {
    _tag: status === "checking" ? "unavailable" : status,
    ...(status === "checking" ? { checking: true } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
    ...(status === "limited" ? { resetsAt: null } : {}),
    ...(status === "sign-in-required" ? { command: "j3-bots provider connect" } : {}),
  },
  models: [],
  usage: [],
});

/** What the running server says of itself, decoded as the CLI decodes it. */
const running = (
  overrides: {
    engine?: object;
    pairedDevices?: number;
    webClient?: AdminStatus["webClient"];
    refusedNames?: ReadonlyArray<string>;
  } = {},
) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(AdminStatus))({
    version: "0.0.0",
    pid: 4242,
    startedAt: "2026-11-20T08:00:00.000Z",
    listener: { scheme: "http", address: "0.0.0.0", port: 3737, names: [] },
    toolPort: 3739,
    enginePort: 3738,
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
  readonly ports: (host: string, port: number) => Exclude<PortState["_tag"], "failed">;
  /** This machine's IPv4 addresses, besides loopback. */
  readonly addresses: ReadonlyArray<string>;
  /** Every executable on the machine, by its full path. */
  readonly executables: ReadonlyArray<string>;
  /** This shell's `PATH`. */
  readonly searchPath: string;
  /** The installed unit's `PATH`. */
  readonly unitPath: string;
  /** Variables set in this shell besides the home and the folders. */
  readonly environment: Record<string, string>;
  readonly server: Option.Option<AdminStatus> | "broken";
  /** Whether the kernel says the unit's main process holds the admin socket, if it can say. */
  readonly holder: Option.Option<boolean>;
  readonly systemd: boolean;
  /** systemd started the machine. */
  readonly booted: boolean;
  /** Files in this user's `~/.ssh` that hold a private key. */
  readonly sshPrivateKeys: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<string>;
  /** Whether a `HEAD` request to a URL succeeds. */
  readonly reachable: boolean;
  readonly unitInstalled: boolean;
  readonly unit: UnitState;
  readonly linger: Linger;
  readonly memoryDelegated: boolean;
  readonly configFile: Option.Option<string>;
  readonly homeMode: number;
  /** The file system fails with EIO when asked about the home, as a failing SD card does. */
  readonly homeUnreadable: boolean;
  /** A regular file where the admin socket goes. */
  readonly socketBlocked: boolean;
  /** A rollback to a snapshot in the home that has not finished. */
  readonly rollbackUnfinished: boolean;
  /**
   * An engine executable J3_ENGINE_BINARY names in this shell, so the engine
   * counts as installed; a server started from this shell, not the service, uses it.
   */
  readonly engineBinary: boolean;
  /** What the engine's browser needs from this host. */
  readonly browser: BrowserHostNeeds;
}

const HEALTHY: World = {
  nodeVersion: "26.13.1",
  platform: "linux",
  freeBytes: Option.some(20 * GIB),
  ports: () => "free",
  addresses: ["192.168.1.20"],
  executables: ["/usr/bin/claude", "/usr/bin/codex"],
  searchPath: "/usr/bin",
  unitPath: "/usr/bin",
  environment: {},
  server: Option.some(running()),
  holder: Option.none(),
  systemd: true,
  booted: true,
  sshPrivateKeys: [],
  groups: ["pi", "users"],
  reachable: true,
  unitInstalled: true,
  unit: { enabled: true, active: "active", mainPid: Option.some(4242) },
  linger: "yes",
  memoryDelegated: true,
  configFile: Option.none(),
  homeMode: 0o700,
  homeUnreadable: false,
  socketBlocked: false,
  rollbackUnfinished: false,
  engineBinary: false,
  browser: {
    sandboxBlocked: false,
    downloaded: true,
    missingLibraries: [],
    noFonts: false,
    setup: [],
    packagesByHand: false,
  },
};

const diagnoseIn = (changes: Partial<World> = {}) =>
  Effect.gen(function* () {
    const world = { ...HEALTHY, ...changes };
    /** Every URL the report asked about. */
    const requests: Array<string> = [];
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
    yield* fs.writeFileString(
      path.join(home, "config.json"),
      Option.getOrElse(world.configFile, () => JSON.stringify({ webClient: web })),
    );
    const engineBinary = path.join(root, "t3");
    if (world.engineBinary) yield* fs.writeFileString(engineBinary, "");
    if (world.socketBlocked) yield* fs.writeFileString(path.join(home, "admin.sock"), "");
    if (world.rollbackUnfinished) {
      yield* markRestoring(
        yield* takeSnapshot({ home, from: { version: "0.1.0" }, to: { version: "0.2.0" } }),
      );
    }
    if (world.unitInstalled) {
      yield* fs.makeDirectory(path.join(configHome, "systemd", "user"), { recursive: true });
      yield* fs.writeFileString(
        path.join(configHome, "systemd", "user", "j3-bots.service"),
        `[Service]\nEnvironment="J3_HOME=${home}"\nEnvironment="PATH=${world.unitPath}"\n`,
      );
    }

    const fakes = Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          HOME: root,
          J3_HOME: home,
          XDG_CONFIG_HOME: configHome,
          ...(world.engineBinary ? { J3_ENGINE_BINARY: engineBinary } : {}),
          ...world.environment,
        }),
      ),
      Layer.succeed(
        Network,
        Network.of({
          ipv4Addresses: Effect.succeed(
            world.addresses.map((address) => ({ interface: "wlan0", address, internal: false })),
          ),
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
          searchPath: world.searchPath,
          installersPath: Effect.succeed(""),
          freeSpace: () => Effect.succeed(world.freeBytes),
          portState: (host, port) => Effect.succeed({ _tag: world.ports(host, port) }),
          holdsSocket: () => Effect.succeed(world.holder),
          sshPrivateKeys: Effect.succeed(world.sshPrivateKeys),
          groups: Effect.succeed(world.groups),
          reachable: (url) =>
            Effect.sync(() => {
              requests.push(url);
              return world.reachable;
            }),
          browserNeeds: () => Effect.succeed(world.browser),
          findExecutable: (name, searchPath) =>
            Effect.succeed(
              Option.fromNullishOr(
                searchPath
                  .split(":")
                  .map((folder) => `${folder}/${name}`)
                  .find((candidate) => world.executables.includes(candidate)),
              ),
            ),
        }),
      ),
      Layer.succeed(
        AdminClient,
        AdminClient.of({
          status: () =>
            world.server === "broken"
              ? Effect.fail(new AdminRequestFailed({ path: "/status", cause: "garbled answer" }))
              : Effect.succeed(world.server),
          startPairing: () => Effect.die("doctor never pairs"),
          connectProviders: () => Effect.die("doctor never connects providers"),
          readiness: () => Effect.die("doctor never waits for an update"),
          runningWork: () => Effect.die("doctor never asks for running work"),
          localDevice: () => Effect.die("doctor never pairs a local device"),
          shutdown: () => Effect.die("doctor never stops the server"),
        }),
      ),
      Layer.succeed(
        Systemd,
        Systemd.of({
          available: Effect.succeed(world.systemd),
          booted: Effect.succeed(world.booted),
          linger: Effect.succeed(world.linger),
          unitState: () => Effect.succeed(world.unit),
          memoryControllerDelegated: Effect.succeed(world.memoryDelegated),
          reload: Effect.die("doctor changes nothing"),
          enableAndRestart: () => Effect.die("doctor changes nothing"),
          disableAndStop: () => Effect.die("doctor changes nothing"),
          stop: () => Effect.die("doctor changes nothing"),
        }),
      ),
    );
    const fileSystem = FileSystem.FileSystem.of({
      ...fs,
      exists: (target) =>
        world.homeUnreadable && target === home
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "access",
                pathOrDescriptor: target,
                cause: Object.assign(new Error(`EIO: i/o error, access '${target}'`), {
                  code: "EIO",
                }),
              }),
            )
          : fs.exists(target),
    });
    const checks = yield* diagnose.pipe(
      Effect.provide(fakes),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    return { checks, home, web, requests };
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
      const { checks, requests } = yield* diagnoseIn();
      const flagged = checks.filter((check) => check.status !== "ok");
      assert.deepStrictEqual(
        flagged.map((check) => `${check.name}: ${check.summary}`),
        [],
      );
      assert.deepStrictEqual(requests, []);
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

  it.effect(
    "reads the running server even when its configuration would refuse the next start",
    () =>
      Effect.gen(function* () {
        // Serving "lan", the machine gained a public address after the server started.
        const { checks } = yield* diagnoseIn({ addresses: ["192.168.1.20", "203.0.113.7"] });
        assertFlagged(named(checks, "Configuration"), "problem", "203.0.113.7");
        const server = named(checks, "Server");
        assert.strictEqual(server.status, "ok");
        assert.include(server.summary, "is running at http://0.0.0.0:3737");
      }),
  );

  it.effect("finds a data directory other users can open a problem, as the server does", () =>
    Effect.gen(function* () {
      const open = named((yield* diagnoseIn({ homeMode: 0o755 })).checks, "Data directory");
      assertFlagged(open, "problem");
      assert.include(
        Option.getOrElse(open.fix, () => ""),
        "chmod 700",
      );
    }),
  );

  it.effect("finds a data directory the file system cannot read a problem, not a first run", () =>
    Effect.gen(function* () {
      const failing = named((yield* diagnoseIn({ homeUnreadable: true })).checks, "Data directory");
      assert.strictEqual(failing.status, "problem");
      assert.include(failing.summary, "EIO: i/o error");
      assert.notInclude(failing.summary, "creates it");
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
      // The running server's own ports are not a conflict; it says where it listens.
      const held = yield* diagnoseIn({ ports: () => "in-use" });
      assert.strictEqual(named(held.checks, "Ports").status, "ok");
      assert.include(named(held.checks, "Ports").summary, "http://0.0.0.0:3737");
      // Its engine's port is as the engine reports it.
      const blocked = yield* diagnoseIn({
        server: Option.some(
          running({
            engine: {
              state: { _tag: "unavailable", reason: "port-in-use" },
              pinnedVersion: "0.1.11",
              providers: [],
            },
          }),
        ),
      });
      assertFlagged(named(blocked.checks, "Ports"), "problem", "3738");
    }),
  );

  it.effect("checks the engine install and that the running engine is the pinned one", () =>
    Effect.gen(function* () {
      // Not installed yet: the server downloads it on its first start, if GitHub answers.
      const notInstalled = yield* diagnoseIn({ server: Option.none() });
      assert.strictEqual(named(notInstalled.checks, "Engine").status, "ok");
      assert.include(named(notInstalled.checks, "Engine").summary, "downloads it from GitHub");
      assert.lengthOf(notInstalled.requests, 1);
      const [download = ""] = notInstalled.requests;
      assert.match(download, /^https:\/\/github\.com\/.+-linux-arm64\.tar\.gz$/);
      const offline = yield* diagnoseIn({ server: Option.none(), reachable: false });
      const unreachable = named(offline.checks, "Engine");
      assertFlagged(unreachable, "problem", "does not answer");
      assert.include(
        Option.getOrElse(unreachable.fix, () => ""),
        `curl -sSIL ${download}`,
      );
      const unsupported = yield* diagnoseIn({ server: Option.none(), platform: "win32" });
      assertFlagged(named(unsupported.checks, "Engine"), "problem", "win32");
      assert.deepStrictEqual(unsupported.requests, []);

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

  it.effect("checks what the browser needs, and how an administrator fixes it", () =>
    Effect.gen(function* () {
      const ready = yield* diagnoseIn();
      assert.strictEqual(named(ready.checks, "Browser").status, "ok");
      const missing = {
        sandboxBlocked: true,
        downloaded: true,
        missingLibraries: ["libnss3.so", "libgbm.so.1"],
        noFonts: true,
      };
      const blocked = yield* diagnoseIn({
        browser: {
          ...missing,
          setup: ["sudo apparmor_parser -r /etc/apparmor.d/t3-chrome-headless-shell"],
          packagesByHand: false,
        },
      });
      const browser = named(blocked.checks, "Browser");
      assertFlagged(browser, "warning", "AppArmor blocks the sandbox");
      assert.include(browser.summary, "libnss3.so, libgbm.so.1");
      assert.include(browser.summary, "no font");
      assert.include(
        Option.getOrElse(browser.fix, () => ""),
        "\n  sudo apparmor_parser -r /etc/apparmor.d/t3-chrome-headless-shell",
      );

      // On a system with neither apt-get nor dnf, the libraries and fonts are the administrator's to install.
      const byHand = yield* diagnoseIn({
        browser: { ...missing, sandboxBlocked: false, setup: [], packagesByHand: true },
      });
      assert.strictEqual(
        Option.getOrElse(named(byHand.checks, "Browser").fix, () => ""),
        "Install libnss3.so, libgbm.so.1, fontconfig and a font with this system's package manager.",
      );

      // Off Linux the browser needs nothing.
      const { checks } = yield* diagnoseIn({
        browser: { ...HEALTHY.browser, sandboxBlocked: true },
        platform: "darwin",
      });
      assert.isUndefined(checks.find((check) => check.name === "Browser"));
    }),
  );

  it.effect("checks each harness is found and signed in, from the engine's provider status", () =>
    Effect.gen(function* () {
      // Nowhere on this machine: the fix names where its maker says how to install it.
      const missing = yield* diagnoseIn({ executables: ["/usr/bin/codex"] });
      const absent = named(missing.checks, "Claude Code");
      assertFlagged(absent, "warning", "claude");
      assert.include(
        Option.getOrElse(absent.fix, () => ""),
        "https://code.claude.com/docs/en/setup",
      );
      assert.strictEqual(named(missing.checks, "Codex").status, "ok");
      const noCodex = yield* diagnoseIn({ executables: ["/usr/bin/claude"] });
      assert.include(
        Option.getOrElse(named(noCodex.checks, "Codex").fix, () => ""),
        "https://developers.openai.com/codex/cli",
      );

      // With the service installed, a harness counts where the service looks.
      const shellOnly = yield* diagnoseIn({
        executables: ["/usr/bin/codex", "/run/user/1000/fnm_multishells/1_2/bin/claude"],
        searchPath: "/run/user/1000/fnm_multishells/1_2/bin:/usr/bin",
        environment: { J3_HOME: "/elsewhere/j3" },
      });
      const shellOnlyClaude = named(shellOnly.checks, "Claude Code");
      assertFlagged(shellOnlyClaude, "warning", "service's PATH");
      // It is installed: the service only needs this shell's PATH, and
      // installing it again keeps the service's own data directory, not this
      // shell's.
      const reinstall = Option.getOrElse(shellOnlyClaude.fix, () => "");
      assert.match(reinstall, /`J3_HOME=\S+ j3-bots service install`/);
      assert.notInclude(reinstall, "/elsewhere/j3");
      assert.notInclude(
        Option.getOrElse(shellOnlyClaude.fix, () => ""),
        "https://",
      );
      const noService = yield* diagnoseIn({
        unitInstalled: false,
        executables: ["/usr/bin/codex", "/opt/claude/bin/claude"],
        searchPath: "/opt/claude/bin:/usr/bin",
      });
      assert.strictEqual(named(noService.checks, "Claude Code").status, "ok");

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
      const claude = named(signedOut.checks, "Claude Code");
      assertFlagged(claude, "problem", "no way to reach its models");
      // The two ways: the connection command the server names, or the harness's own sign-in.
      const ways = Option.getOrElse(claude.fix, () => "");
      assert.include(ways, "`j3-bots provider connect`");
      assert.include(ways, "`j3-bots provider login claude-code`");
      // Found, but the server runs no Codex provider at all.
      assertFlagged(named(signedOut.checks, "Codex"), "warning", "no Codex provider");

      // Codex's sign-in with a code, which also works over SSH, where its browser sign-in waits forever.
      const codexSignedOut = yield* diagnoseIn({
        server: Option.some(
          running({
            engine: {
              state: { _tag: "ready" },
              pinnedVersion: "0.1.11",
              providers: [provider("codex", "sign-in-required")],
            },
          }),
        ),
      });
      assert.include(
        Option.getOrElse(named(codexSignedOut.checks, "Codex").fix, () => ""),
        "`j3-bots provider login codex --device-auth`",
      );
    }),
  );

  it.effect("says a harness the engine has not finished checking is still being checked", () =>
    Effect.gen(function* () {
      const { checks } = yield* diagnoseIn({
        server: Option.some(
          running({
            engine: {
              state: { _tag: "ready" },
              pinnedVersion: "0.1.11",
              providers: [provider("claude-code", "checking"), provider("codex", "checking")],
            },
          }),
        ),
      });
      for (const name of ["Claude Code", "Codex"]) {
        const harness = named(checks, name);
        assertFlagged(harness, "warning", "still checking");
        assert.strictEqual(Option.getOrNull(harness.fix), "Run this again in half a minute.");
      }
      // Nothing is broken, so the report finds no problem to fix.
      assert.isFalse(checks.some((check) => check.status === "problem"));
    }),
  );

  it.effect("says why the engine cannot run a harness it found, and what fixes it", () =>
    Effect.gen(function* () {
      const reported = (reason?: string, detail?: string) =>
        diagnoseIn({
          server: Option.some(
            running({
              engine: {
                state: { _tag: "ready" },
                pinnedVersion: "0.1.11",
                providers: [provider("claude-code", "unavailable", reason, detail)],
              },
            }),
          ),
        }).pipe(Effect.map(({ checks }) => named(checks, "Claude Code")));
      const fixOf = (check: { readonly fix: Option.Option<string> }) =>
        Option.getOrElse(check.fix, () => "");

      const notFound = yield* reported("not-installed");
      assertFlagged(notFound, "problem", "the engine did not find it");
      assert.include(fixOf(notFound), "`systemctl --user restart j3-bots`");

      const failed = yield* reported("failed", "Claude Agent CLI is installed but failed to run.");
      assertFlagged(failed, "problem", "its check of Claude Code failed");
      // In the engine's own words too.
      assert.include(failed.summary, "The engine says: Claude Agent CLI is installed but failed");
      assert.include(fixOf(failed), "`claude --version`");

      const disabled = yield* reported("disabled");
      assertFlagged(disabled, "problem", "turned off");
      assert.include(fixOf(disabled), "names the file");

      // A check that timed out, which the server checks again on its own: a warning, saying when.
      const timedOut = "Timed out while checking Codex app-server provider status.";
      const rechecking = named(
        (yield* diagnoseIn({
          server: Option.some(
            running({
              engine: {
                state: { _tag: "ready" },
                pinnedVersion: "0.1.11",
                providers: [
                  provider("claude-code", "ready"),
                  {
                    ...provider("codex", "unavailable", "failed", timedOut),
                    status: {
                      _tag: "unavailable",
                      checking: false,
                      reason: "failed",
                      detail: timedOut,
                      // The test clock starts at the epoch.
                      retryAt: "1970-01-01T00:00:25.000Z",
                    },
                  },
                ],
              },
            }),
          ),
        })).checks,
        "Codex",
      );
      assertFlagged(rechecking, "warning", "did not end in time");
      assert.include(rechecking.summary, "checks it again on its own in 25 s");
      assert.include(rechecking.summary, `The engine says: ${timedOut}`);
      assert.include(fixOf(rechecking), "Run this again in a minute.");

      // An older server says no reason: the log is all there is to go on.
      const older = yield* reported();
      assertFlagged(older, "problem", "cannot run Claude Code");
      assert.include(fixOf(older), "journalctl");
    }),
  );

  it.effect("checks no harness until the engine is ready, and gives the Engine line's fix", () =>
    Effect.gen(function* () {
      const withEngine = (state: object, providers: ReadonlyArray<object> = []) =>
        diagnoseIn({
          server: Option.some(running({ engine: { state, pinnedVersion: "0.1.11", providers } })),
        });

      // Right after an update: the engine has not answered yet, and the server reports no provider.
      const starting = yield* withEngine({ _tag: "starting" });
      for (const name of ["Claude Code", "Codex"]) {
        const harness = named(starting.checks, name);
        assertFlagged(harness, "warning", "cannot be checked until the engine is ready");
        assert.strictEqual(Option.getOrNull(harness.fix), "Run this again in a minute.");
      }
      assert.isFalse(starting.checks.some((check) => check.status === "problem"));

      // Not answering: the Engine line is the problem, and its fix is the one to follow.
      const down = yield* withEngine({ _tag: "unavailable", reason: "down" });
      const engineFix = named(down.checks, "Engine").fix;
      assertFlagged(named(down.checks, "Engine"), "problem");
      for (const name of ["Claude Code", "Codex"]) {
        const harness = named(down.checks, name);
        assertFlagged(harness, "warning", "cannot be checked until the engine is ready");
        assert.deepStrictEqual(harness.fix, engineFix);
      }

      // Ready, with no provider for a harness: the server itself lacks one.
      const ready = yield* withEngine({ _tag: "ready" }, [provider("claude-code", "ready")]);
      assert.strictEqual(named(ready.checks, "Claude Code").status, "ok");
      const codex = named(ready.checks, "Codex");
      assertFlagged(codex, "warning", "the server has no Codex provider set up");
      assert.include(
        Option.getOrElse(codex.fix, () => ""),
        "Update the server",
      );
    }),
  );

  it.effect("warns while a scripted agent answers instead of a model", () =>
    Effect.gen(function* () {
      const { checks } = yield* diagnoseIn({
        configFile: Option.some(JSON.stringify({ scriptedAgent: SCRIPTED_AGENT })),
      });
      assertFlagged(named(checks, "Scripted agent"), "warning", "scripted-agent/agent.ts");
    }),
  );

  it.effect("checks whether a device is paired, which only the running server knows", () =>
    Effect.gen(function* () {
      const none = yield* diagnoseIn({ server: Option.some(running({ pairedDevices: 0 })) });
      const unpaired = named(none.checks, "Pairing");
      assertFlagged(unpaired, "warning");
      assert.include(
        Option.getOrElse(unpaired.fix, () => ""),
        "`j3-bots pair`",
      );
      const stopped = yield* diagnoseIn({ server: Option.none() });
      assert.strictEqual(named(stopped.checks, "Pairing").status, "skipped");
      assertFlagged(named(stopped.checks, "Server"), "warning");
      const broken = yield* diagnoseIn({ server: "broken" });
      assertFlagged(named(broken.checks, "Server"), "problem");
    }),
  );

  it.effect("warns of the names the running server refused, with what makes it answer them", () =>
    Effect.gen(function* () {
      const { checks } = yield* diagnoseIn({
        server: Option.some(running({ refusedNames: ["bots.example.test"] })),
      });
      const refused = named(checks, "Refused names");
      assertFlagged(refused, "warning", "bots.example.test");
      assert.include(
        Option.getOrElse(refused.fix, () => ""),
        "publicOrigin",
      );
      const quiet = yield* diagnoseIn();
      assert.isUndefined(quiet.checks.find((check) => check.name === "Refused names"));
    }),
  );

  it.effect("says whether the web client is served as the running server reports it", () =>
    Effect.gen(function* () {
      const served = yield* diagnoseIn();
      assert.strictEqual(
        named(served.checks, "Web client").summary,
        "The running server serves it.",
      );

      const stopped = yield* diagnoseIn({ server: Option.none() });
      const built = named(stopped.checks, "Web client");
      assert.strictEqual(built.status, "ok");
      assert.strictEqual(
        built.summary,
        `Built in ${stopped.web}. The server is not running, so it does not serve it yet.`,
      );

      const late = yield* diagnoseIn({
        server: Option.some(running({ webClient: "not-built" })),
      });
      assertFlagged(named(late.checks, "Web client"), "warning", "after the server started");
    }),
  );

  it.effect(
    "finds a file where the admin socket goes a problem, with the command that clears it",
    () =>
      Effect.gen(function* () {
        const { checks, home } = yield* diagnoseIn({ server: Option.none(), socketBlocked: true });
        const server = named(checks, "Server");
        assertFlagged(server, "problem", `${home}/admin.sock is where the admin socket goes`);
        assert.include(
          Option.getOrElse(server.fix, () => ""),
          `mv ${home}/admin.sock`,
        );
      }),
  );

  it.effect("with the service installed, describes only the service's own server", () =>
    Effect.gen(function* () {
      // A server started by hand holds the home, with an engine that is not the pinned one.
      const foreground = Option.some({
        ...running({
          engine: {
            state: { _tag: "incompatible", runningVersion: "0.1.9" },
            pinnedVersion: "0.1.11",
            providers: [],
          },
          pairedDevices: 0,
        }),
        pid: 999,
      });
      const { checks, requests } = yield* diagnoseIn({
        server: foreground,
        ports: () => "in-use",
      });
      assertFlagged(named(checks, "Server"), "warning", "outside the service (process 999)");
      assert.strictEqual(named(checks, "Ports").status, "skipped");
      assert.notInclude(named(checks, "Engine").summary, "0.1.9");
      // Only with no server at all does the report ask GitHub about the download.
      assert.deepStrictEqual(requests, []);
      assert.strictEqual(named(checks, "Pairing").status, "skipped");

      // Without the service, that server is the one the report is about.
      const served = yield* diagnoseIn({ server: foreground, unitInstalled: false });
      assert.strictEqual(named(served.checks, "Server").status, "ok");
      assertFlagged(named(served.checks, "Engine"), "problem", "0.1.9");
    }),
  );

  it.effect("checks the service, lingering and the memory limit", () =>
    Effect.gen(function* () {
      const absent = yield* diagnoseIn({ unitInstalled: false });
      assertFlagged(named(absent.checks, "Service"), "warning");
      const failed = yield* diagnoseIn({
        unit: { enabled: true, active: "failed", mainPid: Option.none() },
      });
      assertFlagged(named(failed.checks, "Service"), "problem");
      // systemd refuses to restart a unit that hit its start limit until that is reset.
      assert.match(
        Option.getOrElse(named(failed.checks, "Service").fix, () => ""),
        /`systemctl --user reset-failed j3-bots`.*`systemctl --user restart j3-bots`/,
      );
      const disabled = yield* diagnoseIn({
        unit: { enabled: false, active: "active", mainPid: Option.some(4242) },
      });
      assertFlagged(named(disabled.checks, "Service"), "warning");
      const restarting = yield* diagnoseIn({
        unit: { enabled: true, active: "activating", mainPid: Option.none() },
      });
      assertFlagged(named(restarting.checks, "Service"), "warning", "restarting");

      const noLinger = yield* diagnoseIn({ linger: "no" });
      assertFlagged(named(noLinger.checks, "Start at boot"), "warning");
      assert.include(
        Option.getOrElse(named(noLinger.checks, "Start at boot").fix, () => ""),
        "enable-linger",
      );

      const unlimited = yield* diagnoseIn({ memoryDelegated: false });
      assertFlagged(named(unlimited.checks, "Memory limit"), "warning");
    }),
  );

  it.effect("gives running `--rollback` as the one fix while a rollback has not finished", () =>
    Effect.gen(function* () {
      // As a rollback cut off after it disabled the service leaves it, with
      // a valid configuration and with one the next start would refuse.
      for (const configFile of [Option.none(), Option.some('{ "prot": 3737 }')]) {
        const { checks } = yield* diagnoseIn({
          configFile,
          rollbackUnfinished: true,
          server: Option.none(),
          unit: { enabled: false, active: "inactive", mainPid: Option.none() },
        });
        assertFlagged(named(checks, "Snapshot"), "problem", "0.1.0");
        assert.include(
          Option.getOrElse(named(checks, "Snapshot").fix, () => ""),
          "`j3-bots update --rollback`",
        );
        for (const name of ["Server", "Service"]) {
          assert.strictEqual(named(checks, name).status, "skipped", name);
        }
        const starts = checks.filter(({ fix }) =>
          Option.exists(fix, (text) =>
            /systemctl --user (start|restart|enable)|j3-bots serve/.test(text),
          ),
        );
        assert.deepStrictEqual(
          starts.map(({ name }) => name),
          [],
        );
      }
    }),
  );

  it.effect("says what runs while a rollback cut off right after its mark has not finished", () =>
    Effect.gen(function* () {
      // The service was not stopped yet: it serves, enabled, on the data the rollback left alone.
      const { checks } = yield* diagnoseIn({ rollbackUnfinished: true });
      const snapshot = named(checks, "Snapshot");
      assertFlagged(snapshot, "problem", "no server starts on the data directory");
      assert.notInclude(snapshot.summary, "disabled");
      assert.include(
        Option.getOrElse(snapshot.fix, () => ""),
        "--rollback --abandon",
      );
      for (const name of ["Server", "Service"]) {
        assert.strictEqual(named(checks, name).status, "ok", name);
      }
    }),
  );

  it.effect("says why this user has no systemd manager, and does not check the service then", () =>
    Effect.gen(function* () {
      const healthy = yield* diagnoseIn();
      assert.strictEqual(named(healthy.checks, "User manager").status, "ok");

      // A shell opened with `su` or `sudo -u` on a systemd machine, the service installed.
      const unreachable = yield* diagnoseIn({ systemd: false });
      const fromSu = named(unreachable.checks, "User manager");
      assertFlagged(fromSu, "problem", "does not answer from this shell");
      assert.include(
        Option.getOrElse(fromSu.fix, () => ""),
        "XDG_RUNTIME_DIR",
      );
      assert.include(
        Option.getOrElse(fromSu.fix, () => ""),
        "enable-linger pi",
      );
      assert.strictEqual(named(unreachable.checks, "Service").status, "skipped");
      assert.isUndefined(unreachable.checks.find((check) => check.name === "Start at boot"));

      // A container, or WSL without systemd.
      const container = yield* diagnoseIn({ systemd: false, booted: false });
      const noSystemd = named(container.checks, "User manager");
      assertFlagged(noSystemd, "problem", "systemd did not start this machine");
      assert.include(
        Option.getOrElse(noSystemd.fix, () => ""),
        "/etc/wsl.conf",
      );
      assert.strictEqual(named(container.checks, "Service").status, "skipped");

      // Without the service, `j3-bots serve` runs; what the manager is still for is said.
      const foreground = yield* diagnoseIn({ systemd: false, unitInstalled: false });
      assertFlagged(
        named(foreground.checks, "User manager"),
        "warning",
        "`j3-bots serve` starts without it. On Linux the engine starts each harness with `systemd-run --user --scope`",
      );

      // macOS has no systemd: neither is checked there.
      const mac = yield* diagnoseIn({ systemd: false, booted: false, platform: "darwin" });
      assert.isUndefined(mac.checks.find((check) => check.name === "User manager"));
      assert.strictEqual(named(mac.checks, "Service").status, "skipped");
    }),
  );

  it.effect(
    "warns when this user holds SSH keys or can become root, with the steps to a user of its own",
    () =>
      Effect.gen(function* () {
        const plain = yield* diagnoseIn();
        assert.strictEqual(named(plain.checks, "This user").status, "ok");

        // `docker run -v /:/host` makes root of a member.
        const docker = yield* diagnoseIn({ groups: ["pi", "users", "docker"] });
        assertFlagged(
          named(docker.checks, "This user"),
          "warning",
          "is in docker, a group that can become root",
        );

        const keys = yield* diagnoseIn({ sshPrivateKeys: ["/home/pi/.ssh/id_ed25519"] });
        const withKeys = named(keys.checks, "This user");
        assertFlagged(withKeys, "warning", "/home/pi/.ssh/id_ed25519");
        assert.include(
          Option.getOrElse(withKeys.fix, () => ""),
          "useradd",
        );

        const admin = yield* diagnoseIn({ groups: ["pi", "sudo"] });
        assertFlagged(
          named(admin.checks, "This user"),
          "warning",
          "is in sudo, a group that can become root",
        );
        const both = yield* diagnoseIn({
          sshPrivateKeys: ["/home/pi/.ssh/id_rsa", "/home/pi/.ssh/deploy"],
          groups: ["wheel"],
        });
        assertFlagged(
          named(both.checks, "This user"),
          "warning",
          "keeps SSH private keys (/home/pi/.ssh/id_rsa, /home/pi/.ssh/deploy) and is in wheel, a group that can become root",
        );

        // Reported even when the configuration is broken.
        const broken = yield* diagnoseIn({
          configFile: Option.some('{ "prot": 3737 }'),
          groups: ["sudo"],
        });
        assertFlagged(named(broken.checks, "This user"), "warning");
      }),
  );

  it.effect("warns that this shell's overrides do not reach the installed service", () =>
    Effect.gen(function* () {
      const overridden = yield* diagnoseIn({ environment: { J3_PORT: "4000" } });
      assertFlagged(named(overridden.checks, "Shell settings"), "warning", "J3_PORT");

      // A typo in this shell is named on its own; the service is still described in full.
      const typo = yield* diagnoseIn({ environment: { J3_PORT: "typo" } });
      assertFlagged(named(typo.checks, "Shell settings"), "problem", "J3_PORT");
      assert.strictEqual(named(typo.checks, "Configuration").status, "ok");
      assert.strictEqual(named(typo.checks, "Server").status, "ok");

      // The report is about the installed service's home, not this shell's.
      const elsewhere = yield* diagnoseIn({ environment: { J3_HOME: "/nonexistent/j3" } });
      assert.notInclude(named(elsewhere.checks, "Data directory").summary, "/nonexistent");
      assert.strictEqual(named(elsewhere.checks, "Server").status, "ok");
      const notInstalled = yield* diagnoseIn({
        unitInstalled: false,
        environment: { J3_PORT: "4000" },
      });
      assert.isUndefined(notInstalled.checks.find((check) => check.name === "Shell settings"));
    }),
  );
});
