// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Free space, a trial listen and the user's name, home and groups have no Effect API.
import * as NodeFs from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { type PortState, portStateOf } from "./Ports.ts";

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
     * The files directly in this user's `~/.ssh` that hold a private key,
     * told by their first line alone; nothing past it is read.
     */
    readonly sshPrivateKeys: Effect.Effect<ReadonlyArray<string>>;
    /** The names of the groups this user is in, as `/etc/group` names them. */
    readonly groups: Effect.Effect<ReadonlyArray<string>>;
    /**
     * Whether `url` answers a `HEAD` request with success, following
     * redirects, within fifteen seconds. Nothing is downloaded.
     */
    readonly reachable: (url: string) => Effect.Effect<boolean>;
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

/** The first line of a PEM or OpenSSH private key, whatever its algorithm and whether or not encrypted. */
const PRIVATE_KEY_HEADER = /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
/** Enough of a file to hold the longest such line. */
const KEY_HEADER_BYTES = 64;

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

export const layer = Layer.effect(
  Host,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const searchPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
    const user = NodeOs.userInfo();

    const nearestExisting = Effect.fn("Host.nearestExisting")(function* (start: string) {
      let folder = path.resolve(start);
      while (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))) {
        const parent = path.dirname(folder);
        if (parent === folder) return folder;
        folder = parent;
      }
      return folder;
    });

    return Host.of({
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      totalMemoryBytes: NodeOs.totalmem(),
      userName: user.username,
      searchPath,
      freeSpace: Effect.fn("Host.freeSpace")(function* (target: string) {
        const folder = yield* nearestExisting(target);
        return yield* Effect.tryPromise({
          try: () => NodeFs.statfs(folder),
          catch: () => "unreadable",
        }).pipe(
          Effect.map((stats) => Option.some(stats.bavail * stats.bsize)),
          Effect.orElseSucceed(() => Option.none()),
        );
      }),
      portState: trialListen,
      findExecutable: Effect.fn("Host.findExecutable")(function* (name: string, folders: string) {
        for (const folder of folders.split(NodePath.delimiter)) {
          if (folder === "") continue;
          const candidate = path.join(folder, name);
          const info = yield* fs.stat(candidate).pipe(Effect.option);
          if (
            Option.isSome(info) &&
            info.value.type === "File" &&
            (info.value.mode & 0o111) !== 0
          ) {
            return Option.some(candidate);
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
      sshPrivateKeys: Effect.gen(function* () {
        const folder = path.join(user.homedir, ".ssh");
        const entries = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
        const keys: Array<string> = [];
        for (const entry of entries.toSorted()) {
          const file = path.join(folder, entry);
          const info = yield* fs.stat(file).pipe(Effect.option);
          // Only regular files: opening a pipe or a device could block or have effects.
          if (Option.isNone(info) || info.value.type !== "File") continue;
          const head = yield* Effect.scoped(
            fs.open(file).pipe(Effect.flatMap((handle) => handle.readAlloc(KEY_HEADER_BYTES))),
          ).pipe(Effect.option);
          const text = Option.flatten(head).pipe(
            Option.map((bytes) => new TextDecoder().decode(bytes)),
          );
          if (Option.isSome(text) && PRIVATE_KEY_HEADER.test(text.value)) keys.push(file);
        }
        return keys;
      }),
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
    });
  }),
);
