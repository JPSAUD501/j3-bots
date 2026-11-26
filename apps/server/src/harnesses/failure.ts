// SPDX-License-Identifier: AGPL-3.0-or-later
import { HarnessInstallFailure } from "@j3-bots/contracts";
import { fileFailure, platformErrorCode } from "@j3-bots/processes";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { PrivateLocationExposed } from "../Layout.ts";
import type { InPlaceFailure } from "./inPlace.ts";

/** Why an install or an update of J3 Bots' copy of a harness did not finish (`HarnessInstallFailure`). */
export class HarnessFailed extends Schema.TaggedError<HarnessFailed>()("HarnessFailed", {
  reason: HarnessInstallFailure,
}) {}

/** A file of a copy that could not be written, checked, moved or removed. */
type FileError = PlatformError.PlatformError | PrivateLocationExposed | InPlaceFailure;

/** The system's code for `error`, the file it was about, and the call that failed, as the log keeps them. */
const described = (error: FileError) => {
  switch (error._tag) {
    case "PrivateLocationExposed":
      return { code: null, file: error.location, call: null };
    case "InPlaceFailure":
      return { code: error.code, file: error.file, call: "open or write" };
    case "PlatformError": {
      const { reason } = error;
      return reason._tag === "BadArgument"
        ? { code: null, file: null, call: `${reason.module}.${reason.method}` }
        : {
            code: platformErrorCode(error),
            file: reason.pathOrDescriptor === undefined ? null : String(reason.pathOrDescriptor),
            call: reason.syscall ?? `${reason.module}.${reason.method}`,
          };
    }
  }
};

/**
 * Fails an install for `error` with the reason it truly comes down to
 * (`fileFailure`; a location that leads out of the home is `outside-home`),
 * logged with the system's code and the file, for the operator's log. On
 * `platform`; `moves` for a rename or a removal, which Windows refuses while
 * another program holds the file.
 */
export const fileFailed = (platform: string, moves: boolean) =>
  Effect.fnUntraced(function* (error: FileError) {
    const { code, file, call } = described(error);
    const reason =
      error._tag === "PrivateLocationExposed"
        ? ("outside-home" as const)
        : fileFailure(code, { platform, moves });
    yield* Effect.logWarning("A file of a harness's copy could not be written").pipe(
      Effect.annotateLogs({ reason, code, file, call }),
    );
    return yield* new HarnessFailed({ reason });
  });
