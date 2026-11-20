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
import { isPrivateAddress, Network } from "../system/Network.ts";
import { refuse, userFacing } from "./errors.ts";

/** Interfaces of containers and virtual networks, which no other device reaches the server through. */
const VIRTUAL_INTERFACE = /^(docker|veth|br-|virbr|cni|flannel|cali|podman)/;

const NOT_RUNNING =
  "The server is not running, and pairing codes live in the running server. Start it with `systemctl --user start j3-bots` (or `j3-bots serve`), then run `j3-bots pair` again.";

/**
 * Where a new device opens the running server, as it listens. Over HTTPS a
 * browser accepts only a name on the certificate, so no bare address is
 * offered; plain HTTP is offered on the private addresses it serves.
 */
const whereToOpen = Effect.fn("pair.whereToOpen")(function* (listener: ListenerStatus) {
  const url = (host: string) =>
    `${listener.scheme}://${NetAddress.formatUrlHostString(host)}:${listener.port}`;
  if (listener.scheme === "https") {
    return listener.names.length === 0
      ? [
          `Open https://<a name the server's certificate covers>:${listener.port} on the new device and enter it there.`,
        ]
      : [
          "Open J3 Bots on the new device and enter it there:",
          ...listener.names.map((name) => `  ${url(name)}`),
        ];
  }
  let hosts = [listener.address];
  if (listener.address === "0.0.0.0") {
    const network = yield* Network;
    hosts = (yield* network.ipv4Addresses)
      .filter(
        (entry) =>
          !entry.internal &&
          !VIRTUAL_INTERFACE.test(entry.interface) &&
          isPrivateAddress(entry.address),
      )
      .map((entry) => entry.address);
  }
  return hosts.length === 0
    ? ["Open J3 Bots on the new device and enter it there."]
    : [
        "Open J3 Bots on the new device and enter it there:",
        ...hosts.map((host) => `  ${url(host)}`),
      ];
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
