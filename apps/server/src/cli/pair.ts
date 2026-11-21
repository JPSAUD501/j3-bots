// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  PairingLink,
  type PairingCode,
  pairingOrigins,
  type ServerOrigin,
} from "@j3-bots/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import { AdminClient } from "../admin/AdminClient.ts";
import type { ListenerStatus } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import { CERTIFICATE_NAME, reachableOrigins } from "../system/Network.ts";
import { refuse, userFacing } from "./errors.ts";
import { terminalQr } from "./qr.ts";

const NOT_RUNNING =
  "The server is not running, and pairing codes live in the running server. Start it with `systemctl --user start j3-bots` (or `j3-bots serve`), then run `j3-bots pair` again.";

/**
 * Where a new device reaches the running server, as it listens, and what to
 * do there. Over HTTPS a browser accepts only a name on the certificate, so
 * no bare address is offered; plain HTTP is offered on the private addresses
 * it serves.
 */
const whereToOpen = (listener: ListenerStatus, origins: ReadonlyArray<ServerOrigin>) => {
  if (origins.length > 0) {
    return [
      "The server listens at:",
      ...origins.map((origin) => `  ${origin}`),
      "On the new device, open J3 Bots at one of these addresses and enter the code.",
    ];
  }
  if (listener.scheme === "https") {
    return [
      `The server listens at https://${CERTIFICATE_NAME}:${listener.port}.`,
      "On the new device, open J3 Bots there and enter the code.",
    ];
  }
  return ["On the new device, open J3 Bots and enter the code."];
};

/**
 * A QR code of the pairing link to the first address another device can
 * reach, for a phone's camera to fill in the server and the code. None when
 * the server offers no such address.
 */
const scanToPair = (origins: ReadonlyArray<ServerOrigin>, code: PairingCode) => {
  const [server] = pairingOrigins(origins);
  if (server === undefined) return [];
  return [
    "",
    `With the J3 Bots app on a phone, scan this to fill in ${server} and the code:`,
    terminalQr(encodeLink({ server, code })),
  ];
};

const encodeLink = Schema.encodeSync(PairingLink);

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
      const { listener } = status.value;
      const origins = yield* reachableOrigins(listener);
      yield* Console.log(
        [
          `Pairing code: ${formatCode(grant.value.code)}`,
          "",
          `It works once, for the next ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          ...whereToOpen(listener, origins),
          ...scanToPair(origins, grant.value.code),
        ].join("\n"),
      );
    }),
  ),
);
