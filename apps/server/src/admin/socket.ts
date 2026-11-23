// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Whether a Unix socket has a listener takes a connect from node:net.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/**
 * Whether the server binds the admin socket on `platform`. Windows has none,
 * nor a named pipe in its place: Node would serve the path as a named pipe,
 * which other users of the machine could open or take first. There the
 * server's only admin channel is the pipe the desktop app hands it when it
 * starts it (`--admin-fd`).
 */
export const hasAdminSocket = (platform: NodeJS.Platform) => platform !== "win32";

/**
 * What is at an admin socket path: nothing, a server that accepts a
 * connection, a socket nothing listens on (its server stopped without
 * closing), or something that is not a socket at all.
 */
export type SocketState = "absent" | "live" | "stale" | "not-a-socket";

export const probe = Effect.fn("AdminSocket.probe")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.lstat(path).pipe(Effect.option);
  if (Option.isNone(info)) return "absent";
  if (info.value.type !== "Socket") return "not-a-socket";
  return yield* Effect.callback<SocketState>((resume) => {
    const socket = NodeNet.connect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed("live"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      // Only a refusal proves that nothing listens; anything else (EACCES,
      // EAGAIN on a full backlog) leaves the socket to whoever made it.
      resume(Effect.succeed(error.code === "ECONNREFUSED" ? "stale" : "live"));
    });
    return Effect.sync(() => socket.destroy());
  });
});
