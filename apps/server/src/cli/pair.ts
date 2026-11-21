// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  bareServerOrigin,
  type PairingCode,
  PairingLink,
  pairingOrigins,
  type ServerOrigin,
} from "@j3-bots/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import { Command, Flag } from "effect/cli";
import { AdminClient } from "../admin/AdminClient.ts";
import type { ListenerStatus } from "../admin/protocol.ts";
import * as ServerConfig from "../config.ts";
import { CERTIFICATE_NAME, reachableOrigins } from "../system/Network.ts";
import { refuse, userFacing } from "./errors.ts";
import { terminalQr } from "./qr.ts";

const NOT_RUNNING =
  "The server is not running, and pairing codes live in the running server. Start it with `systemctl --user start j3-bots` (or `j3-bots serve`), then run `j3-bots pair` again.";

/**
 * Where a new device reaches the running server, and what to do there: its
 * public origin first, when one is set, then where it listens. Over HTTPS a
 * browser accepts only a name on the certificate, so no bare address is
 * offered; plain HTTP is offered on the private addresses it serves.
 */
const whereToOpen = (listener: ListenerStatus, origins: ReadonlyArray<ServerOrigin>) => {
  if (origins.length > 0) {
    return [
      "The server is reached at:",
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

const encodeLink = Schema.encodeSync(PairingLink);

const addressFlag = Flag.String("address").pipe(
  Flag.withDescription(
    "The address the QR code carries, for the phone to open J3 Bots at: a bare http or https origin (scheme, host and port, no path), which the phone must reach exactly as given; https only if the server, or a proxy in front of it, serves https there. One of those the command lists, or an https address the server is reached at, such as a domain a proxy serves. When left out, the first one listed that is not localhost or another loopback address; the command cannot tell which of them the phone reaches.",
  ),
  Flag.optional,
);

const unlockFlag = Flag.Boolean("unlock").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Lift the lock on pairing that repeated wrong codes set, before the code is made. Only the server's user on this machine can.",
  ),
);

/** The lock's end, as the host's clock reads it. */
const lockedText = (until: DateTime.Utc) =>
  `Pairing is locked until ${DateTime.formatLocal(until, { hour: "2-digit", minute: "2-digit" })}, after repeated wrong codes, so no code was made. Run \`j3-bots pair --unlock\` to lift the lock and get a code now.`;

/**
 * The origin the QR code carries: the one the operator chose, which must be a
 * bare origin the server lists or an `https:` one, else the first it lists
 * that names another device, so not `localhost` or another loopback address.
 * None when there is no such origin, as on a server that listens on loopback
 * only. A choice that does not qualify is refused before a code is made.
 */
const carriedOrigin = Effect.fn("pair.carriedOrigin")(function* (
  origins: ReadonlyArray<ServerOrigin>,
  chosen: Option.Option<string>,
) {
  if (Option.isNone(chosen)) return Option.fromUndefinedOr(pairingOrigins(origins)[0]);
  const origin = bareServerOrigin(chosen.value);
  if (Option.isNone(origin)) {
    return yield* refuse(
      "--address takes a bare http or https address: scheme, host and port, with no path, query, fragment or user name. No code was made.",
    );
  }
  // `pairingOrigins` puts an origin first only when it may carry it.
  if (pairingOrigins(origins, origin.value)[0] !== origin.value) {
    return yield* refuse(
      "--address must be one of the addresses the server listens at, as `j3-bots pair` lists them, or an https address another device reaches it at. No code was made.",
    );
  }
  return origin;
});

/**
 * A QR code of the pairing link to `server`, for a phone's camera, under the
 * lines that say which address it carries. Where the terminal cannot show
 * it, the link as text and why there is no QR code.
 */
const scanToPair = Effect.fn("pair.scanToPair")(function* (
  server: ServerOrigin,
  code: PairingCode,
) {
  const link = encodeLink({ server, code });
  const otherAddress = "For another address, run `j3-bots pair --address <address>`.";
  const terminal = yield* Terminal.Terminal;
  const qr = terminalQr(
    link,
    [
      "",
      `Scan this with a phone's camera to open J3 Bots at ${server} with the code filled in.`,
      otherAddress,
    ],
    {
      isTerminal: yield* (yield* Stdio.Stdio).stdoutIsTerminal,
      columns: yield* terminal.columns,
      rows: yield* terminal.rows,
    },
  );
  const asText = ["", `On a phone, open ${link} to pair it with the code filled in.`, otherAddress];
  switch (qr._tag) {
    case "shown":
      return [qr.lines];
    case "not-a-terminal":
      return asText;
    case "too-small":
      return [
        ...asText,
        `For a QR code of it, enlarge this terminal to ${qr.columns} columns by ${qr.rows} rows and run \`j3-bots pair\` again.`,
      ];
  }
});

/** `ABCDE-FGHJK`: two halves, easier to read out and type. */
const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

export const pairCommand = Command.make("pair", {
  address: addressFlag,
  unlock: unlockFlag,
}).pipe(
  Command.withDescription(
    "Print a one-time code that pairs a new device with the running server, and a QR code that opens J3 Bots on a phone with the code filled in. The code works once, within five minutes. While pairing is locked after repeated wrong codes, it says until when; `--unlock` lifts the lock.",
  ),
  Command.withHandler(({ address, unlock }) =>
    Effect.gen(function* () {
      const socket = yield* userFacing(ServerConfig.resolveAdminSocket);
      const admin = yield* AdminClient;
      const status = yield* userFacing(admin.status(socket));
      if (Option.isNone(status)) return yield* refuse(NOT_RUNNING);
      const { listener } = status.value;
      const origins = yield* reachableOrigins(
        listener,
        Option.fromUndefinedOr(status.value.publicOrigin),
      );
      const carried = yield* carriedOrigin(origins, address);
      const offer = yield* userFacing(admin.startPairing(socket, { unlock }));
      if (Option.isNone(offer)) return yield* refuse(NOT_RUNNING);
      if (offer.value._tag === "locked") return yield* refuse(lockedText(offer.value.until));
      const grant = offer.value;
      const now = yield* DateTime.now;
      const minutes = Math.max(
        1,
        Math.round(Duration.toMinutes(DateTime.distance(now, grant.expiresAt))),
      );
      yield* Console.log(
        [
          ...(unlock ? ["Pairing is unlocked.", ""] : []),
          `Pairing code: ${formatCode(grant.code)}`,
          "",
          `It works once, for the next ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          ...whereToOpen(listener, origins),
          ...(Option.isSome(carried) ? yield* scanToPair(carried.value, grant.code) : []),
        ].join("\n"),
      );
    }),
  ),
);
