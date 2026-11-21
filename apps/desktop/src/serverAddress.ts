// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  parseServerAddress as serverOrigin,
  type ServerAddressProblem,
} from "@j3-bots/client-runtime";
import { ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeOrigin = Schema.decodeUnknownOption(ServerOrigin);

/**
 * The server origin an address the operator typed names, by the rule every
 * client that asks for a server applies (`@j3-bots/client-runtime`'s
 * `parseServerAddress`), as the desktop app keeps it.
 */
export const parseServerAddress = (
  typed: string,
): Result.Result<ServerOrigin, ServerAddressProblem> =>
  Result.flatMap(serverOrigin(typed), (origin) =>
    Option.match(decodeOrigin(origin), {
      onNone: () => Result.fail<ServerAddressProblem>("invalid"),
      onSome: Result.succeed,
    }),
  );
