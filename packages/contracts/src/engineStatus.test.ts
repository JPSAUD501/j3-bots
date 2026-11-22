// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderStatus } from "./engineStatus.ts";

describe("an unavailable provider across server versions", () => {
  /** A provider's status as a server and a client from before `checking` read and write it. */
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

  it("is read by an older client, which ignores whether it is checking", () => {
    const newer = Schema.encodeSync(ProviderStatus.fields.status)({
      _tag: "unavailable",
      checking: true,
    });
    assert.deepStrictEqual(Schema.decodeUnknownSync(Before)(newer), { _tag: "unavailable" });
  });
});
