// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AdminStatus } from "./protocol.ts";
import release000 from "./samples/status-0.0.0.json" with { type: "json" };

// During an update the installed release's CLI waits for the new release's
// server on the admin socket, and a rollback has the new CLI read the old
// server, so two releases must read each other's status reply.
//
// This test checks one direction: this release reads every earlier release's
// reply. Each sample is a reply as one release sent it, frozen: never edited,
// and a new one is added when a release changes the reply. The other
// direction, an older CLI reading this release's reply, cannot be tested here,
// since that reader is already shipped. It holds only by a rule: a field may
// be added only as optional, and no field is removed, renamed or changed.
// Existing unions and literals are closed, because an older reader refuses a
// value it does not know, so a new value needs a new optional field. The
// command that waits for an updated server decodes only what it needs from the
// reply, `version` and `pid`.

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
