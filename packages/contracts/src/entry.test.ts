// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { EntryId, EntryOrder } from "./base.ts";
import { EntryPreview, ReceivedEntry } from "./entry.ts";

// As the socket carries them: JSON, which a client decodes with the contract.
const EntriesJson = Schema.toCodecJson(Schema.Array(ReceivedEntry));
const refused = (entries: ReadonlyArray<unknown>) =>
  Exit.isFailure(Schema.decodeUnknownExit(EntriesJson)(entries));
const decodePreview = Schema.decodeSync(Schema.toCodecJson(EntryPreview));

const placed = (n: number) => ({
  id: `e${n}`,
  order: n,
  author: { _tag: "system" },
  createdAt: `2026-11-20T10:0${n}:00.000Z`,
});

const said = (n: number) => ({
  _tag: "message",
  ...placed(n),
  text: "Hello",
  attachments: [],
  mentions: { _tag: "bots", ids: [] },
  delivery: { _tag: "delivered" },
  commandId: null,
});

describe("an entry a client receives", () => {
  it("of a kind, or with a notice, added after this build is unknown, in its place", () => {
    const entries = Schema.decodeSync(EntriesJson)([
      said(1),
      { _tag: "a-kind-from-a-newer-server", ...placed(2), poll: { options: ["A", "B"] } },
      {
        _tag: "notice",
        ...placed(3),
        notice: { _tag: "a-notice-from-a-newer-server", detail: 1 },
        retryable: true,
      },
      said(4),
    ]);
    assert.deepStrictEqual(
      entries.map((entry) => entry._tag),
      ["message", "unknown", "notice", "message"],
    );
    assert.deepStrictEqual(entries[1], {
      _tag: "unknown",
      kind: "a-kind-from-a-newer-server",
      id: EntryId.make("e2"),
      order: EntryOrder.make(2),
      createdAt: DateTime.makeUnsafe("2026-11-20T10:02:00Z"),
    });
    assert.deepStrictEqual(entries[2]?._tag === "notice" && entries[2].notice, {
      _tag: "unknown",
      kind: "a-notice-from-a-newer-server",
    });
  });

  it("of a kind this build knows is refused when it does not decode, not taken as unknown", () => {
    const { text: _, ...textless } = said(1);
    assert.isTrue(refused([textless]));
    assert.isTrue(
      refused([
        { _tag: "notice", ...placed(1), notice: { _tag: "chain-stopped" }, retryable: false },
      ]),
    );
  });

  it("previewed in the roster has an unknown kind when it came after this build", () => {
    const preview = decodePreview({
      entryId: "e1",
      kind: "a-kind-from-a-newer-server",
      author: { _tag: "system" },
      text: "",
      recipientId: null,
      createdAt: "2026-11-20T10:00:00.000Z",
    });
    assert.strictEqual(preview.kind, "unknown");
  });
});
