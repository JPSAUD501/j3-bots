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

  it("reads an older server's answer as not checking", () => {
    const older = Schema.encodeSync(Before)({ _tag: "unavailable" });
    assert.deepStrictEqual(Schema.decodeSync(ProviderStatus.fields.status)(older), {
      _tag: "unavailable",
      checking: false,
    });
  });
});
