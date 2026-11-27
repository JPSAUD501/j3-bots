// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A trial listen and the user's name, home and groups have no Effect API.
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { freeSpaceAt } from "./freeSpace.ts";
import { type PortState, portStateOf } from "./Ports.ts";
import { runPowerShell } from "./PowerShell.ts";
import { privateKeysIn } from "./sshKeys.ts";

/** The facts about this machine that `j3-bots doctor` and `service` read. */
export class Host extends Context.Service<
  Host,
  {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
    readonly totalMemoryBytes: number;
    /** The login name the server runs as. */
    readonly userName: string;
    /** `PATH` as this process has it, from which a service unit's is made. */
    readonly searchPath: string;
    /**
     * On Windows, the `PATH` a program started now gets, which an installer
     * may have changed since this process started: the user's, then the
     * machine's, as Windows keeps them, read again on each call; empty when
     * they cannot be read, and elsewhere.
     */
    readonly installersPath: Effect.Effect<string>;
    /** Bytes free to this user on the filesystem holding `path`, or its nearest existing parent. */
    readonly freeSpace: (path: string) => Effect.Effect<Option.Option<number>>;
    /** Whether the server could listen on `host` and `port` right now. */
    readonly portState: (host: string, port: number) => Effect.Effect<PortState>;
    /** The first executable file named `name` in the folders of `searchPath`. */
    readonly findExecutable: (
      name: string,
      searchPath: string,
    ) => Effect.Effect<Option.Option<string>>;
    /**
     * Whether process `pid` holds the Unix socket that listens at
     * `socketPath`, as the kernel reports it in `/proc`. `None` when that
     * cannot be told: no `/proc`, no listening socket at that path in it, or
     * the process's descriptors unreadable.
     */
    readonly holdsSocket: (
      pid: number,
      socketPath: string,
    ) => Effect.Effect<Option.Option<boolean>>;
    /**
     * The files directly in this user's `~/.ssh` that hold a private key, by
     * path (`privateKeysIn`): up to the first 64 bytes of each regular file
     * are read, and no symbolic link is followed.
     */
    readonly sshPrivateKeys: Effect.Effect<ReadonlyArray<string>>;
    /**
     * The names of the groups this user is in, as `/etc/group` names them: a
     * group known only to a directory service, such as LDAP through sssd, is
     * not named.
     */
    readonly groups: Effect.Effect<ReadonlyArray<string>>;
    /**
     * Whether `url` answers a `HEAD` request with success, following
     * redirects, within fifteen seconds. Nothing is downloaded.
     */
    readonly reachable: (url: string) => Effect.Effect<boolean>;
    /**
     * What the engine's headless browser needs from this Linux host, for the
     * engine's data directory `home`: it reads the AppArmor settings, and
     * runs the downloaded browser, `ldd`, `fc-match` and `apt-cache` to ask
     * about libraries, fonts and packages. `sandboxRefused`: the running
     * server says the engine found the sandbox blocked.
     */
    readonly browserNeeds: (input: {
      readonly home: string;
      readonly sandboxRefused: boolean;
    }) => Effect.Effect<EngineLive.BrowserHostNeeds>;
  }
>()("@j3-bots/server/system/Host") {}

const trialListen = (host: string, port: number) =>
  Effect.callback<PortState>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resume(Effect.succeed(portStateOf(error.code ?? error.message))),
    );
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resume(Effect.succeed({ _tag: "free" })));
    });
    return Effect.sync(() => server.close());
  });

/** `__SO_ACCEPTCON`: the socket listens. */
const LISTENING = 0x10000;

/**
 * The inodes of the Unix sockets listening at `socketPath`, from the text of
 * `/proc/net/unix`: `Num RefCount Protocol Flags Type St Inode Path`, the path
 * last and taking the rest of the line.
 */
const listeningInodes = (table: string, socketPath: string) => {
  const inodes = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const match = /^\S+\s+\S+\s+\S+\s+([0-9A-Fa-f]+)\s+\S+\s+\S+\s+(\d+) (.*)$/.exec(line);
    if (match === null) continue;
    const [, flags = "0", inode = "", path = ""] = match;
    if ((Number.parseInt(flags, 16) & LISTENING) !== 0 && path === socketPath) inodes.add(inode);
  }
  return inodes;
};

/** Group names by id, from the text of `/etc/group`: `name:password:gid:members`. */
const groupNames = (table: string) => {
  const names = new Map<number, string>();
  for (const line of table.split("\n")) {
    const [name = "", , gid = ""] = line.split(":");
    if (name !== "" && /^\d+$/.test(gid)) names.set(Number(gid), name);
  }
  return names;
};

const REACHABLE_WITHIN = "15 seconds";

/**
 * Prints the user's `PATH`, then the machine's, a line each, as Windows
 * keeps them for a program started now, the way T3 Code's engine reads them
 * again before it looks for a harness (**Read** at `bc0f04d`,
 * `windowsEnvironmentValueCommand` in `packages/shared/src/shell.ts`). A
 * folder given as `%VARIABLE%` comes expanded (**Assumed**: .NET expands a
 * `REG_EXPAND_SZ` value as it reads it).
 */
const INSTALLERS_PATH =
  "@([Environment]::GetEnvironmentVariable('PATH','User'), [Environment]::GetEnvironmentVariable('PATH','Machine')) | Where-Object { $_ } | ForEach-Object { Write-Output $_ }";

/**
 * The file names a command `name` is found as. On Windows, `name` with each
 * extension `PATHEXT` lists, `.COM;.EXE;.BAT;.CMD` when it lists none: a
 * harness is `claude.exe`, or the `.cmd` shim npm installs. Elsewhere, `name`.
 */
export const executableNames =
  (platform: string, pathExtensions: string) =>
  (name: string): ReadonlyArray<string> => {
    if (platform !== "win32") return [name];
    const listed = pathExtensions.split(";").filter((extension) => extension.startsWith("."));
    return (listed.length > 0 ? listed : [".COM", ".EXE", ".BAT", ".CMD"]).map(
      (extension) => `${name}${extension.toLowerCase()}`,
    );
  };

export const layer = Layer.effect(
  Host,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const searchPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
    const pathExtensions = yield* Config.String("PATHEXT").pipe(Config.withDefault(""));
    const candidates = executableNames(process.platform, pathExtensions);
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
    const user = NodeOs.userInfo();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return Host.of({
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      totalMemoryBytes: NodeOs.totalmem(),
      userName: user.username,
      searchPath,
      installersPath:
        process.platform === "win32"
          ? runPowerShell(INSTALLERS_PATH, {}).pipe(
              Effect.map((output) =>
                output
                  .split(/\r?\n/)
                  .filter((line) => line.trim() !== "")
                  .join(";"),
              ),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.orElseSucceed(() => ""),
            )
          : Effect.succeed(""),
      freeSpace: Effect.fn("Host.freeSpace")(function* (target: string) {
        return yield* freeSpaceAt(target).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }),
      portState: trialListen,
      findExecutable: Effect.fn("Host.findExecutable")(function* (name: string, folders: string) {
        for (const folder of folders.split(NodePath.delimiter)) {
          if (folder === "") continue;
          for (const file of candidates(name)) {
            const candidate = path.join(folder, file);
            const info = yield* fs.stat(candidate).pipe(Effect.option);
            if (
              Option.isSome(info) &&
              info.value.type === "File" &&
              // Windows has no execute bit: what runs is said by the extension.
              (process.platform === "win32" || (info.value.mode & 0o111) !== 0)
            ) {
              return Option.some(candidate);
            }
          }
        }
        return Option.none();
      }),
      holdsSocket: Effect.fn("Host.holdsSocket")(function* (pid: number, socketPath: string) {
        const table = yield* fs.readFileString("/proc/net/unix").pipe(Effect.option);
        if (Option.isNone(table)) return Option.none();
        const inodes = listeningInodes(table.value, socketPath);
        if (inodes.size === 0) return Option.none();
        const descriptors = path.join("/proc", String(pid), "fd");
        const entries = yield* fs.readDirectory(descriptors).pipe(Effect.option);
        if (Option.isNone(entries)) return Option.none();
        for (const entry of entries.value) {
          const target = yield* fs.readLink(path.join(descriptors, entry)).pipe(Effect.option);
          const inode = Option.flatMap(target, (link) =>
            Option.fromNullishOr(/^socket:\[(\d+)\]$/.exec(link)?.[1]),
          );
          if (Option.isSome(inode) && inodes.has(inode.value)) return Option.some(true);
        }
        return Option.some(false);
      }),
      sshPrivateKeys: privateKeysIn(path.join(user.homedir, ".ssh")),
      groups: Effect.gen(function* () {
        const table = yield* fs.readFileString("/etc/group").pipe(Effect.orElseSucceed(() => ""));
        const names = groupNames(table);
        return (process.getgroups?.() ?? []).flatMap((gid) => {
          const name = names.get(gid);
          return name === undefined ? [] : [name];
        });
      }),
      reachable: Effect.fn("Host.reachable")((url: string) =>
        client.execute(HttpClientRequest.head(url)).pipe(
          Effect.map((response) => response.status >= 200 && response.status < 300),
          Effect.timeout(REACHABLE_WITHIN),
          Effect.orElseSucceed(() => false),
        ),
      ),
      browserNeeds: Effect.fn("Host.browserNeeds")(
        (input: { readonly home: string; readonly sandboxRefused: boolean }) =>
          EngineLive.inspectBrowserHost(input),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    });
  }),
);
