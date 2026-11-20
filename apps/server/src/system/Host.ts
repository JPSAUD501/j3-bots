// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Free space, a trial listen and the user name have no Effect API.
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

export const layer = Layer.effect(
  Host,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const searchPath = yield* Config.String("PATH").pipe(Config.withDefault(""));

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
      userName: NodeOs.userInfo().username,
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
    });
  }),
);
