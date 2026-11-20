// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Whether a Unix socket has a listener takes a connect from node:net.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * What is at an admin socket path: nothing, a server that accepts a
 * connection, or a file a server left behind when it stopped without closing.
 */
export type SocketState = "absent" | "live" | "stale";

export const probe = Effect.fn("AdminSocket.probe")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return "absent";
  return yield* Effect.callback<SocketState>((resume) => {
    const socket = NodeNet.connect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed("live"));
    });
    socket.once("error", () => {
      socket.destroy();
      resume(Effect.succeed("stale"));
    });
    return Effect.sync(() => socket.destroy());
  });
});
