// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AdminStatus } from "./protocol.ts";
import release000 from "./samples/status-0.0.0.json" with { type: "json" };

// During an update the installed release's CLI waits for the new release's
// server on the admin socket, and a rollback has the new CLI read the old
// server, so two releases must read each other's status reply. Each sample is
// a reply as one release sent it, frozen: never edited, and a new one is added
// when a release changes the reply. A field may be added as optional and never
// removed, renamed or narrowed.

const SAMPLES = { "0.0.0": release000 };

/** The reply as it crosses the socket: JSON, as both ends read and write it. */
const AdminStatusJson = Schema.toCodecJson(AdminStatus);

describe("the admin status reply", () => {
  for (const [release, sample] of Object.entries(SAMPLES)) {
    it(`reads release ${release}'s, and writes back every field it had`, () => {
      const status = Schema.decodeSync(AdminStatusJson)(sample);
      assert.deepStrictEqual<unknown>(Schema.encodeSync(AdminStatusJson)(status), sample);
    });
  }
});
