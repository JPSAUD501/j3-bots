// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";
import { AdminClient } from "../admin/AdminClient.ts";
import * as ServerConfig from "../config.ts";
import { Network } from "../system/Network.ts";
import { refuse, userFacing } from "./errors.ts";

/** The addresses a device on the network can open the server at. */
const serverUrls = Effect.fn("pair.serverUrls")(function* (config: ServerConfig.ServerConfigShape) {
  const scheme = Option.isSome(config.tls) ? "https" : "http";
  if (config.host !== "0.0.0.0") return [`${scheme}://${config.host}:${config.port}`];
  const network = yield* Network;
  const addresses = (yield* network.ipv4Addresses).filter(({ internal }) => !internal);
  return addresses.map(({ address }) => `${scheme}://${address}:${config.port}`);
});

/** `ABCDE-FGHJK`: two halves, easier to read out and type. */
const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

export const pairCommand = Command.make("pair").pipe(
  Command.withDescription(
    "Print a one-time code that pairs a new device with the running server. It works once, within five minutes.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* userFacing(ServerConfig.load);
      const admin = yield* AdminClient;
      const grant = yield* userFacing(admin.startPairing(config.adminSocket));
      if (Option.isNone(grant)) {
        return yield* refuse(
          "The server is not running, and pairing codes live in the running server. Start it with `systemctl --user start j3-bots` (or `j3-bots serve`), then run `j3-bots pair` again.",
        );
      }
      const now = yield* DateTime.now;
      const minutes = Math.max(
        1,
        Math.round(Duration.toMinutes(DateTime.distance(now, grant.value.expiresAt))),
      );
      const urls = yield* serverUrls(config);
      yield* Console.log(
        [
          `Pairing code: ${formatCode(grant.value.code)}`,
          "",
          `It works once, for the next ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          urls.length === 0
            ? "Open J3 Bots on the new device and enter it there."
            : `Open J3 Bots on the new device and enter it there:\n${urls.map((url) => `  ${url}`).join("\n")}`,
        ].join("\n"),
      );
    }),
  ),
);
