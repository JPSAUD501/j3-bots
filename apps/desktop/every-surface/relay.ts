// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a TCP relay is node:net's to make.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";

// The desktop app's way to the server in the every-surface check: a TCP relay
// on loopback that the check cuts, as a network would drop, and restores. The
// app names the relay as its server, so cutting it leaves the server and the
// phone as they were.

export interface Relay {
  /** The relay's `host:port`, the address the desktop app is given. */
  readonly host: string;
  /** Drops every connection through the relay and refuses new ones. */
  readonly cut: Effect.Effect<void>;
  /** Takes connections again. */
  readonly restore: Effect.Effect<void>;
}

interface Running {
  readonly server: NodeNet.Server;
  readonly sockets: Set<NodeNet.Socket>;
  readonly relay: Relay;
}

/** A relay to `target`'s host and port, for the scope. */
export const relayTo = (target: URL) =>
  Effect.acquireRelease(
    Effect.callback<Running>((resume) => {
      // The check always names the port; an address without one is a mistake in its settings.
      if (target.port === "") {
        resume(Effect.die(`The server's address names no port: ${target.href}`));
        return;
      }
      const port = Number(target.port);
      const sockets = new Set<NodeNet.Socket>();
      let open = true;
      const server = NodeNet.createServer((client) => {
        if (!open) {
          client.destroy();
          return;
        }
        const upstream = NodeNet.connect(port, target.hostname);
        const end = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", end);
          socket.on("error", end);
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address !== null && typeof address === "object" ? address.port : 0;
        resume(
          Effect.succeed({
            server,
            sockets,
            relay: {
              host: `127.0.0.1:${port}`,
              cut: Effect.sync(() => {
                open = false;
                for (const socket of sockets) socket.destroy();
                sockets.clear();
              }),
              restore: Effect.sync(() => {
                open = true;
              }),
            },
          }),
        );
      });
    }),
    // close() waits for open connections to end: the app's socket would hold it open.
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      }),
  ).pipe(Effect.map(({ relay }) => relay));
