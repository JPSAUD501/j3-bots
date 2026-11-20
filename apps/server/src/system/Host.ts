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

/**
 * Whether the server could listen on an address and port right now:
 * `in-use` by another program, `not-local` when the address is not one of
 * this machine's, `denied` when the user may not bind it, or another error,
 * by its code.
 */
export type PortState =
  | { readonly _tag: "free" }
  | { readonly _tag: "in-use" }
  | { readonly _tag: "not-local" }
  | { readonly _tag: "denied" }
  | { readonly _tag: "failed"; readonly code: string };

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
    readonly portState: (host: string, port: number) => Effect.Effect<PortState>;
    /** The first executable file named `name` in the folders of `searchPath`. */
    readonly findExecutable: (
      name: string,
      searchPath: string,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("@j3-bots/server/system/Host") {}

const trialListen = (host: string, port: number) =>
  Effect.callback<PortState>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      switch (error.code) {
        case "EADDRINUSE":
          return resume(Effect.succeed({ _tag: "in-use" }));
        case "EADDRNOTAVAIL":
          return resume(Effect.succeed({ _tag: "not-local" }));
        case "EACCES":
          return resume(Effect.succeed({ _tag: "denied" }));
        default:
          return resume(Effect.succeed({ _tag: "failed", code: error.code ?? error.message }));
      }
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resume(Effect.succeed({ _tag: "free" })));
    });
    return Effect.sync(() => server.close());
  });

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
    });
  }),
);
