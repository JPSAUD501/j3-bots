// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A trial listen on each address a port is checked on, which only Node's own sockets can make.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as WindowsAclModule from "@j3-bots/server/windows-acl";

// The data home of the server the app runs: `<userData>/server/home`, the
// app's own, apart from a server the operator installed from the command line
// (`~/.j3-bots`), with ports of its own. The app trusts what answers on its
// admin socket only because no one else can reach the home, so it checks
// that, as the server does, before it starts or takes over a server there.

/**
 * How the app reads and sets who may open a folder on Windows, which its
 * mode bits do not say: the server's own reader and creator, so the app
 * judges a home exactly as the server it starts there will.
 */
export interface WindowsAcl {
  readonly read: (
    folder: string,
  ) => Effect.Effect<
    WindowsAclModule.FolderAcl,
    WindowsAclModule.AclUnreadable,
    ChildProcessSpawner
  >;
  readonly createPrivate: (
    folder: string,
  ) => Effect.Effect<void, WindowsAclModule.AclUnreadable, ChildProcessSpawner>;
}

/** Windows' own answer, through PowerShell. */
export const systemAcl: WindowsAcl = {
  read: WindowsAclModule.readFolderAcl,
  createPrivate: WindowsAclModule.createPrivateFolder,
};

/** The system the home is on, and on Windows how its access list is read and set. */
export interface HomeSystem {
  readonly platform: NodeJS.Platform;
  readonly acl: WindowsAcl;
}

/** The home is not one only this user can open, and how to repair it. */
class HomeNotPrivate extends Schema.TaggedError<HomeNotPrivate>()("HomeNotPrivate", {
  home: Schema.String,
  platform: Schema.String,
  reason: Schema.Literals([
    "not-a-folder",
    "not-owned",
    "open-to-others",
    "closed-to-owner",
    "unverifiable",
  ]),
  /** On Windows, the `icacls` command that makes the home private, naming the accounts to remove. */
  windowsRepair: Schema.optionalKey(Schema.String),
  /** For `unverifiable`, what Windows said instead of who may open the home. */
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-folder":
        return `${this.home} is where this computer's bots keep their data, but it is not a folder.`;
      case "not-owned":
        return `${this.home}, where this computer's bots keep their data, belongs to another user.`;
      case "open-to-others":
        return `Other users on this computer can open ${this.home}, where this computer's bots keep their data and their keys.`;
      case "closed-to-owner":
        return `Your own permissions on ${this.home}, where this computer's bots keep their data, do not let you read and write the files there.`;
      case "unverifiable":
        return `Windows did not say who can open ${this.home}, where this computer's bots keep their data${this.detail === undefined ? "" : ` (${this.detail})`}.`;
    }
  }

  /** What repairs it, for the operator to do. */
  get fix(): string {
    if (this.reason === "not-a-folder") return `Move ${this.home} out of the way, then try again.`;
    if (this.platform === "win32") {
      const repair = this.windowsRepair ?? `icacls "${this.home}" /inheritance:r`;
      switch (this.reason) {
        case "not-owned":
          return `Take it as your user (\`takeown /F "${this.home}" /R\`), then run \`${repair}\`, then try again.`;
        case "open-to-others":
        case "closed-to-owner":
          return `Run \`${repair}\`, then try again.`;
        case "unverifiable":
          return "Check that Windows PowerShell runs for your user, then try again.";
      }
    }
    switch (this.reason) {
      case "not-owned":
        return `Give it to this user (\`sudo chown -R "$(id -un)": '${this.home}'\`), then try again.`;
      case "open-to-others":
        return `Close it to others (\`chmod 700 '${this.home}'\`), then try again.`;
      case "closed-to-owner":
      case "unverifiable":
        return `Open it to yourself alone (\`chmod 700 '${this.home}'\`), then try again.`;
    }
  }
}

/**
 * Whether `home` may hold the server's data, as the server judges it when it
 * starts there, so the app never starts a server that then refuses its home:
 * a folder owned by this user that this user may read, write and search and
 * no group and no other user can open (on Windows, by its access list), or
 * nothing yet (`prepareHome` creates it private).
 */
export const checkHome = Effect.fn("LocalHome.checkHome")(function* (
  home: string,
  system: HomeSystem,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(home).pipe(Effect.option);
  if (Option.isNone(info)) return;
  const refuse = (
    reason: HomeNotPrivate["reason"],
    more: { readonly windowsRepair?: string; readonly detail?: string } = {},
  ) => new HomeNotPrivate({ home, platform: system.platform, reason, ...more });
  if (info.value.type !== "Directory") return yield* refuse("not-a-folder");
  if (system.platform === "win32") {
    const acl = yield* system.acl
      .read(home)
      .pipe(Effect.mapError((error) => refuse("unverifiable", { detail: error.detail })));
    const verdict = WindowsAclModule.judgeAcl(acl);
    if (verdict !== "private") {
      return yield* refuse(verdict, { windowsRepair: WindowsAclModule.repairCommand(home, acl) });
    }
    return;
  }
  const user = process.getuid?.();
  if (user !== undefined && Option.isSome(info.value.uid) && info.value.uid.value !== user) {
    return yield* refuse("not-owned");
  }
  if ((info.value.mode & 0o077) !== 0) return yield* refuse("open-to-others");
  if ((info.value.mode & 0o700) !== 0o700) return yield* refuse("closed-to-owner");
});

/**
 * Creates `home`, and the folders it is in, if missing, private from its
 * first moment: on Windows with its access list in place, as the server
 * creates its own, elsewhere mode 0700. A home another process made first is
 * checked as an existing one is.
 */
const createHome = Effect.fnUntraced(function* (home: string, system: HomeSystem) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (system.platform !== "win32") {
    yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
    return yield* fs.chmod(home, 0o700);
  }
  if (yield* fs.exists(home)) return;
  yield* fs.makeDirectory(path.dirname(home), { recursive: true });
  yield* system.acl.createPrivate(home).pipe(
    Effect.mapError(
      (error) =>
        new HomeNotPrivate({
          home,
          platform: system.platform,
          reason: "unverifiable",
          detail: error.detail,
        }),
    ),
  );
  yield* checkHome(home, system);
});

// ---------------------------------------------------------------------------
// Ports

/** Where the app's own server starts looking for free ports: clear of the command line's 3737–3739. */
const FIRST_PORT = 3747;
const LAST_PORT = 65535;
/**
 * Where a port must be free: loopback, the only address the server listens
 * on. A listen on the wildcard addresses would make Windows ask the operator
 * to let the app through its firewall, for a port only this computer uses.
 * On Linux a program on the wildcard address takes the port on loopback too;
 * on Windows and macOS it does not stop a listen on loopback alone, which is
 * all the server makes (**Assumed** for macOS).
 */
const LOOPBACK = "127.0.0.1";

/** Whether `port` is free on `host`: a listen there succeeds. An address this system lacks counts as free. */
const freeOn = (host: string, port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resume(Effect.succeed(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")),
    );
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resume(Effect.succeed(true)));
    });
    return Effect.sync(() => server.close());
  });

/** Whether `port` is free on loopback. */
export const isFree = (port: number) => freeOn(LOOPBACK, port);

/** No three free ports were found from `FIRST_PORT` up. */
export class NoFreePorts extends Schema.TaggedError<NoFreePorts>()("NoFreePorts", {}) {
  override get message(): string {
    return `No free ports were found from ${FIRST_PORT} up for this computer's server.`;
  }
}

/**
 * Ports for the server's clients, its tool endpoint and its engine: `port`
 * for its clients when one is given, and otherwise free on loopback, the
 * lowest from `FIRST_PORT` up.
 */
export const choosePorts = Effect.fn("LocalHome.choosePorts")(function* (
  free: (port: number) => Effect.Effect<boolean> = isFree,
  port?: number,
) {
  const chosen: Array<number> = port === undefined ? [] : [port];
  for (let next = FIRST_PORT; next <= LAST_PORT && chosen.length < 3; next += 1) {
    if (next !== port && (yield* free(next))) chosen.push(next);
  }
  const [clientPort, toolPort, enginePort] = chosen;
  if (clientPort === undefined || toolPort === undefined || enginePort === undefined) {
    return yield* new NoFreePorts();
  }
  return { port: clientPort, toolPort, enginePort };
});

// ---------------------------------------------------------------------------
// config.json

/** The settings of the home's `config.json` the app chooses and reads. */
const HomeConfig = Schema.Struct({
  port: Schema.optionalKey(Schema.Int),
});
const decodeHomeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(HomeConfig));

/** What the app writes to a new home's `config.json`. */
const WrittenConfig = Schema.Struct({
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Int,
  toolPort: Schema.Int,
  enginePort: Schema.Int,
  webClient: Schema.Null,
  tls: Schema.Null,
  publicOrigin: Schema.Null,
});
const encodeWrittenConfig = Schema.encodeEffect(Schema.fromJsonString(WrittenConfig, { space: 2 }));

/** The port the server's own defaults give clients when `config.json` names none. */
const DEFAULT_PORT = 3737;

/**
 * The home's `config.json` is there, and its client port cannot be read: the
 * file could not be opened (`unreadable`, with the system's reason), or it is
 * not a configuration J3 Bots reads (`invalid`). Either way it stays as it is.
 */
class HomeConfigUnreadable extends Schema.TaggedError<HomeConfigUnreadable>()(
  "HomeConfigUnreadable",
  {
    file: Schema.String,
    reason: Schema.Literals(["unreadable", "invalid"]),
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === "unreadable"
      ? `J3 Bots cannot read ${this.file}${this.detail === undefined ? "" : ` (${this.detail})`}. Give your user read access to it, or delete it to have the app write it again.`
      : `${this.file} is not a configuration J3 Bots can read. Repair it, or delete it to have the app write it again.`;
  }
}

/**
 * The client port of the server at `home`, after making its `config.json` on
 * the first start, in a home created private if missing: loopback only (the host is set again on each start, by
 * `J3_HOST`), and three free ports chosen once. A file that exists is never
 * rewritten: its port stays, so the origin the page signed in to does too.
 */
export const prepareHome = Effect.fn("LocalHome.prepareHome")(function* (
  home: string,
  system: HomeSystem,
  ports: Effect.Effect<
    { readonly port: number; readonly toolPort: number; readonly enginePort: number },
    NoFreePorts
  >,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(home, "config.json");
  // Only a file that is not there is written; one that cannot be read is
  // the operator's, and refused, never replaced.
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeedNone
        : Effect.fail(
            new HomeConfigUnreadable({ file, reason: "unreadable", detail: error.reason._tag }),
          ),
    ),
  );
  if (Option.isSome(text)) {
    const config = decodeHomeConfig(text.value);
    if (Option.isNone(config)) return yield* new HomeConfigUnreadable({ file, reason: "invalid" });
    return config.value.port ?? DEFAULT_PORT;
  }
  const chosen = yield* ports;
  yield* createHome(home, system);
  const temporary = `${file}.tmp`;
  const written = yield* encodeWrittenConfig({
    host: "127.0.0.1",
    port: chosen.port,
    toolPort: chosen.toolPort,
    enginePort: chosen.enginePort,
    webClient: null,
    tls: null,
    publicOrigin: null,
  });
  yield* fs.writeFileString(temporary, `${written}\n`, { mode: 0o600 });
  yield* fs.rename(temporary, file);
  return chosen.port;
});

/**
 * The home's `config.json` sets another client port than the one the app
 * reaches the server at, where the page and its sign-in are kept.
 */
class HomePortMoved extends Schema.TaggedError<HomePortMoved>()("HomePortMoved", {
  file: Schema.String,
  port: Schema.Int,
  kept: Schema.Int,
}) {
  override get message(): string {
    return `${this.file} sets this computer's server on port ${this.port}, but the app reaches it on port ${this.kept}.`;
  }

  /** What repairs it, for the operator to do. */
  get fix(): string {
    return `Set "port" back to ${this.kept} in it, or stop using this computer in Settings and choose it again, which signs it in on port ${this.port}.`;
  }
}

/**
 * The client port of the server at `home`, as the app keeps reaching it on
 * `kept`: a `config.json` that went missing is written again with that port,
 * so the page's origin stays, and one that sets another is refused, since
 * the page would not find the server there.
 */
export const prepareKeptHome = Effect.fn("LocalHome.prepareKeptHome")(function* (
  home: string,
  system: HomeSystem,
  kept: number,
  free: (port: number) => Effect.Effect<boolean> = isFree,
) {
  const path = yield* Path.Path;
  const port = yield* prepareHome(home, system, choosePorts(free, kept));
  if (port !== kept) {
    return yield* new HomePortMoved({ file: path.join(home, "config.json"), port, kept });
  }
  return port;
});
