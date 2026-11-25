// SPDX-License-Identifier: AGPL-3.0-or-later
import { HarnessInstallFailure } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

/** Why an install or an update of J3 Bots' copy of a harness did not finish (`HarnessInstallFailure`). */
export class HarnessFailed extends Schema.TaggedError<HarnessFailed>()("HarnessFailed", {
  reason: HarnessInstallFailure,
}) {}
