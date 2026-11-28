// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the store of certificates Node's sockets trust is Node's own setting.
import * as NodeTls from "node:tls";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { type HostSocketEnd, type PageHost, serveHostOnSocket } from "@j3-bots/browser";
import { HTTP_PATHS } from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Socket from "effect/socket/Socket";

// The desktop's browser on the server (decision 0110): the app dials the
// server's page host socket with its device token and answers the server's
// calls on it, for as long as the app is signed in there. A link that drops
// is dialed again, waiting longer each time it fails at once.

/** The first wait after a link that failed at once, doubled up to the longest. */
const FIRST_WAIT = Duration.seconds(1);
const LONGEST_WAIT = Duration.seconds(30);
/** A link that lasted this long was a good one: the next failure waits the first wait again. */
const GOOD_LINK = Duration.seconds(30);
const OPEN_TIMEOUT = Duration.seconds(10);

/** The page host socket of the server at `origin` (`http(s)://host[:port]`). */
const hostSocketUrl = (origin: string): string => {
  const url = new URL(HTTP_PATHS.browserHost, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
};

/** The wait before dialing again, after a link that lasted `lasted` and the wait before it. */
const nextWait = (lasted: Duration.Duration, previous: Duration.Duration | null) =>
  previous === null || Duration.isGreaterThanOrEqualTo(lasted, GOOD_LINK)
    ? FIRST_WAIT
    : Duration.min(Duration.times(previous, 2), LONGEST_WAIT);

/**
 * Makes Node's sockets, the link among them, trust what the system trusts
 * besides Node's own authorities, as the page and Electron's `net` do: a
 * server whose certificate an organisation's own authority signed is
 * reached too. The link is Node's WebSocket, since Electron's network stack
 * has none that sends a header; it goes straight to the server, never
 * through the system's proxy. For the whole main process, once, at start.
 */
export const trustSystemCertificates = Effect.sync(() =>
  NodeTls.setDefaultCACertificates([
    ...NodeTls.getCACertificates("default"),
    ...NodeTls.getCACertificates("system"),
  ]),
);

/**
 * Serves `host` to the server at `origin`, signed in with `token`, until
 * interrupted. When a link ends, `refused` says whether the server no
 * longer takes the token; if so, `onRefused` runs and the link stops, since
 * dialing again would be refused too.
 */
export const linkToServer = (options: {
  readonly origin: string;
  readonly token: Redacted.Redacted<string>;
  readonly host: PageHost;
  readonly refused: Effect.Effect<boolean>;
  readonly onRefused: Effect.Effect<void>;
  /** Told how each link ended, for the app's log. */
  readonly ended?: ((end: HostSocketEnd) => Effect.Effect<void>) | undefined;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const url = hostSocketUrl(options.origin);
    let wait: Duration.Duration | null = null;
    while (true) {
      const began = yield* Clock.currentTimeMillis;
      const socket = yield* Socket.makeWebSocket(url, {
        headers: { authorization: `Bearer ${Redacted.value(options.token)}` },
        openTimeout: OPEN_TIMEOUT,
      });
      const end = yield* serveHostOnSocket(options.host, socket);
      if (options.ended !== undefined) yield* options.ended(end);
      if (yield* options.refused) return yield* options.onRefused;
      const lasted = Duration.millis((yield* Clock.currentTimeMillis) - began);
      wait = nextWait(lasted, wait);
      yield* Effect.sleep(wait);
    }
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
