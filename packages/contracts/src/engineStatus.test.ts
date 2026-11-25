// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderStatus } from "./engineStatus.ts";

describe("an unavailable provider across server versions", () => {
  /** A provider's status as a server from before `checking` writes it. */
  const Before = Schema.Union([
    Schema.TaggedStruct("ready", {}),
    Schema.TaggedStruct("unavailable", {}),
  ]);
  const decodeStatus = Schema.decodeUnknownSync(ProviderStatus.fields.status);

  it("reads an older server's answer as not checking, with no reason", () => {
    const older = Schema.encodeSync(Before)({ _tag: "unavailable" });
    assert.deepStrictEqual(decodeStatus(older), { _tag: "unavailable", checking: false });
  });

  it("reads a reason a newer server gives as unknown", () => {
    assert.deepStrictEqual(
      decodeStatus({ _tag: "unavailable", checking: false, reason: "quarantined" }),
      { _tag: "unavailable", checking: false, reason: "unknown" },
    );
  });
});
