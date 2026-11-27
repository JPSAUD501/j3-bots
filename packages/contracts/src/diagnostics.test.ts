// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { diagnosticsFileName } from "./diagnostics.ts";

it("names a diagnostics zip by when it was made, in UTC, so a day's zips sort by time", () => {
  assert.strictEqual(
    diagnosticsFileName(DateTime.makeUnsafe("2026-01-05T09:07:59.999Z")),
    "j3-bots-diagnostics-2026-01-05-0907.zip",
  );
  assert.strictEqual(
    diagnosticsFileName(DateTime.makeUnsafe("2026-12-31T23:59:00+02:00")),
    "j3-bots-diagnostics-2026-12-31-2159.zip",
  );
});
