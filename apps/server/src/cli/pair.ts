// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";
import * as NetAddress from "effect/net/NetAddress";
import { AdminClient } from "../admin/AdminClient.ts";
import type { ListenerStatus } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import { reachableHosts } from "../system/Network.ts";
import { refuse, userFacing } from "./errors.ts";

const NOT_RUNNING =
  "The server is not running, and pairing codes live in the running server. Start it with `systemctl --user start j3-bots` (or `j3-bots serve`), then run `j3-bots pair` again.";

/**
 * Where a new device reaches the running server, as it listens, and what to
 * do there. Over HTTPS a browser accepts only a name on the certificate, so
 * no bare address is offered; plain HTTP is offered on the private addresses
 * it serves.
 */
const whereToOpen = Effect.fn("pair.whereToOpen")(function* (listener: ListenerStatus) {
  const url = (host: string) =>
    `${listener.scheme}://${NetAddress.formatUrlHostString(host)}:${listener.port}`;
  const listing = (addresses: ReadonlyArray<string>) =>
    addresses.length === 0
      ? ["On the new device, open J3 Bots and enter the code."]
      : [
          "The server listens at:",
          ...addresses.map((address) => `  ${url(address)}`),
          "On the new device, open J3 Bots at one of these addresses and enter the code.",
        ];
  const hosts = yield* reachableHosts(listener);
  if (listener.scheme === "https" && hosts.length === 0) {
    return [
      `The server listens at https://<a name the server's certificate covers>:${listener.port}.`,
      "On the new device, open J3 Bots there and enter the code.",
    ];
  }
  return listing(hosts);
});

/** `ABCDE-FGHJK`: two halves, easier to read out and type. */
const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

export const pairCommand = Command.make("pair").pipe(
  Command.withDescription(
    "Print a one-time code that pairs a new device with the running server. It works once, within five minutes.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const socket = yield* userFacing(ServerConfig.resolveAdminSocket);
      const admin = yield* AdminClient;
      const status = yield* userFacing(admin.status(socket));
      if (Option.isNone(status)) return yield* refuse(NOT_RUNNING);
      const grant = yield* userFacing(admin.startPairing(socket));
      if (Option.isNone(grant)) return yield* refuse(NOT_RUNNING);
      const now = yield* DateTime.now;
      const minutes = Math.max(
        1,
        Math.round(Duration.toMinutes(DateTime.distance(now, grant.value.expiresAt))),
      );
      yield* Console.log(
        [
          `Pairing code: ${formatCode(grant.value.code)}`,
          "",
          `It works once, for the next ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          ...(yield* whereToOpen(status.value.listener)),
        ].join("\n"),
      );
    }),
  ),
);
