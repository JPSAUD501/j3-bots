// SPDX-License-Identifier: AGPL-3.0-or-later
import { type LocalServerState, ServerOrigin, type ServerUpdate } from "@j3-bots/desktop-bridge";
import * as Network from "@j3-bots/server/network";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type * as ServerChoice from "../serverChoice.ts";
import { DesktopSettings } from "../settings.ts";
import * as AdminChannel from "./adminChannel.ts";
import * as Credential from "./credential.ts";
import * as Home from "./home.ts";
import * as Orphans from "./orphans.ts";
import * as PhoneAccess from "./phoneAccess.ts";
import * as Runtime from "./runtime.ts";
import * as ServerProcess from "./serverProcess.ts";
import * as ShellPath from "./shellPath.ts";
import * as Supervisor from "./supervisor.ts";
import * as VersionTransition from "./versionTransition.ts";

// The server this computer runs for its bots ("local mode"): where its files
// are, whether this computer can run it, and the supervisor, sign-in and
// mode change the app drives it with.
//
//   <userData>/server/home              its data home (J3_HOME)
//   <userData>/server/server.log        its output, appended at each start
//   <userData>/server/server.pid        the last one started (Windows)
//   <userData>/server-runtime/<version> the runtimes of the releases it ran
//
// Which release starts on the home, and the move from one to the next that
// an app update brings, is `versionTransition.ts`'s.

/** The systems the app runs the server on, as `<platform>-<arch>`. */
const SUPPORTED = new Set(["linux-x64", "win32-x64"]);
/** Opens local mode on Apple silicon, until someone has run it on a real Mac. */
const EXPERIMENTAL_FLAG = "J3_EXPERIMENTAL_LOCAL_MODE";

export interface LocalHostOptions {
  readonly packaged: boolean;
  /** `process.resourcesPath`: where a package carries the runtime. */
  readonly resourcesPath: string;
  /** `app.getAppPath()`: `apps/desktop` in development. */
  readonly appPath: string;
  readonly userData: string;
  /**
   * The app's own build of the web client, which the server serves too: a
   * phone that opens the pairing link reaches it there.
   */
  readonly webClient: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly hostname: string;
  readonly loginShell: string | null;
  readonly windowsPrivacy: Home.WindowsPrivacy;
}

/**
 * Node variables the server keeps: the certificates the operator trusts
 * beyond Node's own (a company proxy's), which its harnesses and engine
 * download through.
 */
const NODE_KEPT = new Set(["NODE_EXTRA_CA_CERTS"]);

/** Variables of the app's environment the server must not inherit. */
const isAppOnly = (name: string) =>
  (/^(ELECTRON_|J3_|NODE_|npm_)/.test(name) && !NODE_KEPT.has(name)) ||
  ["APPIMAGE", "APPDIR", "ARGV0", "OWD"].includes(name) ||
  name.toUpperCase() === "PATH";

/**
 * The server's environment: the app's, without what belongs to Electron, an
 * AppImage, Node (but the certificates it trusts) or a J3 Bots setting in
 * the operator's shell (the server's
 * settings come from its home's `config.json`), with the operator's PATH,
 * its home, the address it listens on and the web client it serves.
 */
export const serverEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly path: string;
    readonly home: string;
    readonly host: string;
    readonly webClient: string;
  },
): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isAppOnly(name)) kept[name] = value;
  }
  return {
    ...kept,
    PATH: options.path,
    J3_HOME: options.home,
    J3_HOST: options.host,
    J3_WEB_CLIENT: options.webClient,
  };
};

const decodeOrigin = Schema.decodeUnknownEffect(ServerOrigin);

/** The port of the loopback origin the app keeps for its server. */
const portOf = (origin: ServerOrigin): number => {
  const url = new URL(origin);
  return url.port === "" ? 80 : Number(url.port);
};

/** The supervisor's state with what the server's version is going through. */
const withUpdate = (state: LocalServerState, update: Option.Option<ServerUpdate>) =>
  Option.match(update, {
    onNone: () => state,
    onSome: (now): LocalServerState => ({ ...state, update: now }),
  });

export const make = Effect.fn("LocalHost.make")(function* (options: LocalHostOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* DesktopSettings;
  const serverFolder = path.join(options.userData, "server");
  const home = path.join(serverFolder, "home");
  const logFile = path.join(serverFolder, "server.log");
  const pidFile = path.join(serverFolder, "server.pid");
  const adminSocket = path.join(home, "admin.sock");
  // What the supervisor's launches, and the page's mode change, run with.
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner>();
  const target = `${options.platform}-${options.arch}`;
  // A package carries the runtime for its own system; a development build
  // takes the one `scripts/build-release.ts --server-runtime` builds for it.
  const source = options.packaged
    ? path.join(options.resourcesPath, "server-runtime")
    : path.join(options.appPath, "..", "..", "dist", "release", "server-runtime", target);

  const supported =
    SUPPORTED.has(target) || (target === "darwin-arm64" && options.env[EXPERIMENTAL_FLAG] === "1");
  const bundled = supported ? yield* Runtime.releaseOf(source).pipe(Effect.option) : Option.none();
  const available = Option.isSome(bundled);
  if (supported && !available) {
    yield* Effect.logWarning(
      "This build carries no server runtime; local mode is unavailable",
      source,
    );
  }

  const shellPath = yield* Effect.cached(
    ShellPath.probePath({
      platform: options.platform,
      env: options.env,
      home: options.homeDirectory,
      loginShell: options.loginShell,
    }),
  );

  const checkHome = Home.checkHome(home, options.platform, options.windowsPrivacy);

  // Where each start listens: on this computer alone, or, while the operator
  // lets phones reach it, on the network.
  const network = yield* Network.Network.pipe(Effect.provide(Network.layer));
  const phone = yield* PhoneAccess.listening({
    publicAddress: network.ipv4Addresses.pipe(Effect.map(Network.publicAddressOf)),
  });

  /** Starts the server from `runtime`. */
  const run = Effect.fn("LocalHost.run")(function* (runtime: Runtime.Runtime) {
    yield* fs.makeDirectory(serverFolder, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
    const server = yield* ServerProcess.launch({
      node: runtime.node,
      entry: runtime.entry,
      env: serverEnvironment(options.env, {
        path: yield* shellPath,
        home,
        host: yield* phone.hostForLaunch,
        webClient: options.webClient,
      }),
      logFile,
      platform: options.platform,
    });
    if (options.platform === "win32") yield* Orphans.record(pidFile, server.pid, runtime.node);
    return server;
  }, Effect.provideContext(context));

  const versions = Option.isSome(bundled)
    ? Option.some(
        yield* VersionTransition.make({
          home,
          source,
          bundled: bundled.value,
          runtimes: path.join(options.userData, "server-runtime"),
          platform: options.platform,
          run,
        }),
      )
    : Option.none();

  const launch = Effect.gen(function* () {
    if (Option.isNone(versions)) {
      return yield* new Supervisor.LaunchFailed({
        reason: `This copy of J3 Bots carries no server to run on this computer (${source}).`,
        retry: false,
      });
    }
    yield* checkHome.pipe(
      Effect.mapError(
        (refusal) =>
          new Supervisor.LaunchFailed({ reason: refusal.message, fix: refusal.fix, retry: false }),
      ),
    );
    // Every start makes the home ready, as choosing this computer did, on the
    // port the page is kept on: a config.json that went missing is written
    // again rather than left to the server's own defaults.
    const kept = (yield* settings.get).server;
    yield* (
      kept === null
        ? Home.prepareHome(home, Home.choosePorts())
        : Home.prepareKeptHome(home, portOf(kept))
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "HomePortMoved"
          ? new Supervisor.LaunchFailed({ reason: error.message, fix: error.fix, retry: false })
          : new Supervisor.LaunchFailed({
              reason: error.message,
              retry: error._tag === "NoFreePorts" || error._tag === "PlatformError",
            }),
      ),
    );
    return yield* versions.value.launch;
  }).pipe(Effect.provideContext(context));

  const adopt = Effect.gen(function* () {
    if (Option.isNone(versions)) return Option.none<Supervisor.RunningServer>();
    if (options.platform === "win32") {
      yield* Orphans.stopRecorded(pidFile, (pid) => ServerProcess.killTree(pid, options.platform));
      return Option.none<Supervisor.RunningServer>();
    }
    // Only a private home's socket is the app's own server.
    const trusted = yield* checkHome.pipe(Effect.isSuccess);
    if (!trusted || !(yield* fs.exists(adminSocket).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none<Supervisor.RunningServer>();
    }
    const processes = yield* Orphans.systemProcesses(options.platform);
    return yield* versions.value.adopt((version) =>
      Orphans.takeOverOnSocket(AdminChannel.overSocket(adminSocket), version, processes),
    );
  }).pipe(Effect.provideContext(context));

  const onReady = Option.match(versions, {
    onNone: () => Effect.void,
    onSome: (now) => now.onReady.pipe(Effect.provideContext(context)),
  });

  const supervisor = yield* Supervisor.make({ launch, adopt, onReady });
  const update = Option.match(versions, {
    onNone: () => Effect.succeed(Option.none<ServerUpdate>()),
    onSome: (now) => now.update,
  });
  const updates = Option.match(versions, {
    onNone: () => Stream.make(Option.none<ServerUpdate>()),
    onSome: (now) => now.updates,
  });

  /** The server's state, as the page and the tray are told it. */
  const state = Effect.zipWith(supervisor.state, update, withUpdate);
  const changes = Stream.zipLatestWith(supervisor.changes, updates, withUpdate);

  /**
   * Tries the app's release again after the server was rolled back from it:
   * the server that runs stops, and the next start moves the data again.
   */
  const retryUpdate = Effect.gen(function* () {
    if (Option.isNone(versions) || !(yield* versions.value.retry)) return;
    yield* supervisor.stop;
    yield* supervisor.start;
  });

  const prepare = Effect.gen(function* () {
    yield* checkHome;
    const port = yield* Home.prepareHome(home, Home.choosePorts());
    return yield* decodeOrigin(`http://127.0.0.1:${port}`);
  }).pipe(Effect.provideContext(context));

  const local: ServerChoice.LocalServer = {
    available,
    prepare,
    start: supervisor.start,
    stop: supervisor.stop,
  };

  const signIn = yield* Credential.make({
    supervisor,
    name: Credential.deviceName(options.hostname),
  });

  return {
    available,
    local,
    supervisor,
    phone,
    state,
    changes,
    retryUpdate,
    signIn,
    logFile,
  } as const;
});
