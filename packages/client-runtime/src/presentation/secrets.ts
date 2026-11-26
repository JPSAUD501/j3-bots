// SPDX-License-Identifier: AGPL-3.0-or-later
import { LoginOrigins, siteOriginOf } from "@j3-bots/contracts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeOrigins = Schema.decodeUnknownOption(LoginOrigins);

/**
 * The sites a login is for, typed one per line (or apart by spaces), each as
 * its origin and each once. None when a line names no site, or there are none
 * or too many.
 */
export const typedOrigins = (typed: string): Option.Option<LoginOrigins> => {
  const lines = typed.split(/\s+/).filter((line) => line !== "");
  return Option.flatMap(Option.all(lines.map(siteOriginOf)), (found) =>
    decodeOrigins(Arr.dedupe(found)),
  );
};
