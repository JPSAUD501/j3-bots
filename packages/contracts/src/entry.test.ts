// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { EntryId, EntryOrder } from "./base.ts";
import { BotState } from "./bot.ts";
import { EntryPreview, MessageDelivery, ReceivedEntry } from "./entry.ts";
import { MAX_VISUAL_BYTES, visualEscapesGuard } from "./visual.ts";

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

  it("of a failed turn, or a blocked bot, with a failure class added after this build fails for no named reason", () => {
    const [failed] = Schema.decodeSync(EntriesJson)([
      {
        _tag: "notice",
        ...placed(1),
        notice: { _tag: "turn-failed", failure: "a-failure-from-a-newer-server" },
        retryable: true,
      },
    ]);
    assert.deepStrictEqual(failed?._tag === "notice" && failed.notice, {
      _tag: "turn-failed",
      failure: "unknown",
    });
    assert.deepStrictEqual(
      Schema.decodeSync(Schema.toCodecJson(BotState))({
        _tag: "blocked",
        failure: "a-failure-from-a-newer-server",
        retryAt: null,
      }),
      { _tag: "blocked", failure: "unknown", retryAt: null },
    );
  });

  it("keeps a message whose offer came after this build, offering nothing it does not know", () => {
    const [offered, extended] = Schema.decodeSync(EntriesJson)([
      { ...said(1), offer: { kind: "an-offer-from-a-newer-server" } },
      { ...said(2), offer: { kind: "record-screen", detail: { screens: 2 } } },
    ]);
    assert.deepStrictEqual(offered?._tag === "message" && offered.offer, { kind: "unknown" });
    assert.deepStrictEqual(extended?._tag === "message" && extended.offer, {
      kind: "record-screen",
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

describe("a message held behind a bot's hello across versions", () => {
  /** A message's delivery as a client from before `behindOpening` decodes it. */
  const Before = Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("delivered", {}),
    Schema.TaggedStruct("cancelled", {}),
    Schema.TaggedStruct("failed", {
      reason: Schema.Literals(["rejected", "unresolved", "stopped"]),
    }),
  ]);
  const held = Schema.encodeSync(MessageDelivery)({ _tag: "pending", behindOpening: true });

  it("reads as an ordinary pending message to an older client", () => {
    assert.deepStrictEqual(Schema.decodeSync(Before)(held), { _tag: "pending" });
  });

  it("reads an older server's pending message as waiting behind nothing", () => {
    const older = Schema.encodeSync(Before)({ _tag: "pending" });
    assert.deepStrictEqual(Schema.decodeSync(MessageDelivery)(older), { _tag: "pending" });
  });
});

describe("a message's visual", () => {
  const shown = (visual: Record<string, unknown>) => ({
    ...said(1),
    author: { _tag: "bot", botId: "b1" },
    visual: { title: "Spending by month", html: "<p>Chart</p>", height: 320, ...visual },
  });

  it("is refused when its page is blank, over the cap or not well-formed text", () => {
    assert.isFalse(refused([shown({})]));
    assert.isTrue(refused([shown({ html: " \n" })]));
    // 'é' is two bytes in UTF-8: under the cap in characters, over it in bytes.
    assert.isTrue(refused([shown({ html: "é".repeat(MAX_VISUAL_BYTES / 2 + 1) })]));
    assert.isFalse(refused([shown({ html: "é".repeat(MAX_VISUAL_BYTES / 2) })]));
    assert.isTrue(refused([shown({ html: "<p>\ud800</p>" })]));
  });
});

describe("a visual's page", () => {
  it("escapes the guard wherever its text has a frame's start tag, in any case", () => {
    for (const html of [
      "<iframe srcdoc='<p>'></iframe>",
      "<IFRAME\tsrc=x>",
      "<div><template shadowrootmode=closed><iframe></iframe></template></div>",
      "<frame/>",
      '<object data="data:text/html,x">',
      "<embed>",
      "<script>const tag = '<iframe>';</script>",
    ]) {
      assert.isTrue(visualEscapesGuard(html), html);
    }
  });

  it("escapes the guard wherever its text gives an element a declarative shadow root", () => {
    for (const html of [
      '<div><template shadowrootmode="open"></template></div>',
      "<x-a><TEMPLATE SHADOWROOTMODE=closed></TEMPLATE></x-a>",
      "<template/shadowrootmode=open>",
      '<template id="a"shadowrootmode="open">',
      "<template\nshadowrootmode = 'open'>",
      '<template shadowroot="open">',
    ]) {
      assert.isTrue(visualEscapesGuard(html), html);
    }
  });

  it("keeps to the guard when it only names one, holds a longer tag that starts the same, or reads a shadow root in a script", () => {
    for (const html of [
      "<p>&lt;iframe&gt; is not allowed</p>",
      "<frameset></frameset>",
      "<objective-list></objective-list>",
      "<embedded-chart></embedded-chart>",
      "<svg><text>iframe</text></svg>",
      "<script>if (host.shadowRoot == null) host.attachShadow({ mode: 'open' });</script>",
      "<p>A shadowrootmode attribute is not used here.</p>",
    ]) {
      assert.isFalse(visualEscapesGuard(html), html);
    }
  });
});
