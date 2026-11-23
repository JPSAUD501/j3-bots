// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { EntryId, EntryOrder, UnknownLiteral } from "./base.ts";
import {
  Connector,
  ConnectorAddress,
  ConnectorSource,
  ConnectorStatus,
  ConnectorTransport,
  displayTransport,
  SignInStarted,
} from "./connector.ts";
import { ConnectorsEvent } from "./rpc.ts";
import {
  ApprovalEntry,
  ConnectorAuthEntry,
  ConnectorSuggestionEntry,
  HandoffEntry,
  MessageEntry,
  QuestionEntry,
  ReceivedEntry,
  ReceivedNoticeEntry,
  RoutineChangeEntry,
  SecretRequestEntry,
  WorkFoldEntry,
} from "./entry.ts";

// As the socket carries them: JSON, which each side decodes with the contract.
const json = Schema.toCodecJson;

const connector = {
  id: "conn_0123456789abcdef",
  name: "Notion",
  glyph: "notion",
  publisher: { _tag: "domain", domain: "notion.com" },
  listing: { _tag: "curated", key: "notion" },
  transport: { _tag: "remote", origin: "https://mcp.notion.com" },
  signIn: "oauth",
  fields: [],
  status: { _tag: "failing", reason: "timed-out", since: "2026-11-23T10:00:00.000Z" },
  grant: { _tag: "bots", ids: ["b1"] },
  account: "operator@example.com",
  signedInAt: "2026-11-22T09:00:00.000Z",
  tools: [{ name: "search", title: "Search", description: "Searches pages." }],
  review: {
    revision: "r2",
    kept: false,
    changes: [
      {
        _tag: "changed",
        tool: { name: "search", title: "Search", description: "Searches pages and comments." },
        previous: { name: "search", title: "Search", description: "Searches pages." },
        inputChanged: false,
      },
      { _tag: "added", tool: { name: "delete", title: null, description: "Deletes a page." } },
    ],
  },
  createdAt: "2026-11-22T08:59:00.000Z",
};

describe("a connector", () => {
  it("reaches a client as the server sent it", () => {
    const decoded = Schema.decodeSync(json(Connector))(connector);
    assert.deepStrictEqual(Schema.encodeSync(json(Connector))(decoded), connector);
  });

  it("is reached only at an https: address with no user name or fragment", () => {
    const accepts = (url: string) => Exit.isSuccess(Schema.decodeExit(json(ConnectorAddress))(url));
    assert.isTrue(accepts("https://mcp.example.com/mcp"));
    assert.isTrue(accepts("https://mcp.example.com:8443/v1/mcp?tenant=a"));
    assert.isFalse(accepts("http://mcp.example.com/mcp"));
    assert.isFalse(accepts("https://user:secret@mcp.example.com/mcp"));
    assert.isFalse(accepts("https://token@mcp.example.com/mcp"));
    assert.isFalse(accepts("https://mcp.example.com/mcp#tools"));
    assert.isFalse(accepts("mcp.example.com/mcp"));
    // What a URL parser would drop, so the address parsed and the one kept could differ.
    assert.isFalse(accepts("https://mcp.example.com/m\tcp"));
    assert.isFalse(accepts("https://mcp.example.com/mcp\r\nX: 1"));
  });

  it("with a reason a newer server added reads as one this build cannot name", () => {
    const decode = Schema.decodeSync(json(ConnectorStatus));
    const decodeExit = Schema.decodeExit(json(ConnectorStatus));
    assert.deepStrictEqual(decode({ _tag: "needs-sign-in", reason: "a-newer-reason" }), {
      _tag: "needs-sign-in",
      reason: "unknown",
    });
    assert.strictEqual(
      decode({ _tag: "failing", reason: "a-newer-reason", since: "2026-11-23T10:00:00.000Z" })._tag,
      "failing",
    );
    // A known state that does not decode is refused, never taken as unknown.
    assert.isTrue(Exit.isFailure(decodeExit({ _tag: "failing", reason: "unreachable" })));
  });
});

describe("what a client sends to add a connector", () => {
  const TOKEN = "github_pat_value-never-printed";
  const remote = (value: string) => ({
    _tag: "remote",
    name: "Tracker",
    url: "https://mcp.example.com/mcp",
    headers: [{ name: "Authorization", value: `Bearer ${value}` }],
    oauthClient: {
      issuer: "https://accounts.google.com",
      clientId: "client-id",
      clientSecret: value,
    },
    privateNetwork: false,
  });

  it("is redacted as soon as it is decoded, and goes back on the wire as sent", () => {
    const source = Schema.decodeSync(json(ConnectorSource))(remote(TOKEN));
    assert.strictEqual(source._tag, "remote");
    if (source._tag !== "remote") return;
    const [header] = source.headers;
    assert.isDefined(header);
    if (header === undefined) return;
    assert.notInclude(String(header.value), TOKEN);
    assert.notInclude(JSON.stringify(source), TOKEN);
    assert.strictEqual(Redacted.value(header.value), `Bearer ${TOKEN}`);
    assert.deepStrictEqual(Schema.encodeSync(json(ConnectorSource))(source), remote(TOKEN));
  });

  it("is refused with a line break, which would start another header, and the refusal never prints it", () => {
    const exit = Schema.decodeExit(json(ConnectorSource))(remote(`${TOKEN}\r\nX-Other: 1`));
    assert.isTrue(Exit.isFailure(exit));
    assert.notInclude(String(exit), TOKEN);
    const badName = Schema.decodeExit(json(ConnectorSource))({
      ...remote(TOKEN),
      headers: [{ name: "Authorization: x", value: TOKEN }],
    });
    assert.isTrue(Exit.isFailure(badName));
  });
});

describe("a key in a connector's address or command", () => {
  const KEY = "sk_live_sentinel-never-shown";
  const byAddress = {
    _tag: "remote",
    name: "Tracker",
    url: `https://mcp.example.com/${KEY}/mcp?api_key=${KEY}`,
    headers: [],
    oauthClient: null,
    privateNetwork: false,
  };
  const byCommand = {
    _tag: "command",
    name: "Files",
    command: "npx",
    args: ["-y", "files-mcp", `--api-key=${KEY}`],
    env: [],
  };
  it("is never in the connector a client is sent back, nor in what a subscription sends", () => {
    const shown = Schema.decodeSync(json(Connector))(connector);
    const added = [byAddress, byCommand].map((sent) => {
      const source = Schema.decodeSync(json(ConnectorSource))(sent);
      assert.notInclude(String(source), KEY);
      if (source._tag === "listing") throw new Error("a source by address or by command");
      return { ...shown, transport: displayTransport(source) };
    });
    // `connector.add` answers with a `Connector`.
    const response = Schema.encodeSync(json(Schema.Array(Connector)))(added);
    assert.deepStrictEqual(
      added.map((one) => Schema.encodeSync(ConnectorTransport)(one.transport)),
      [
        { _tag: "remote", origin: "https://mcp.example.com" },
        { _tag: "command", program: "npx" },
      ],
    );
    assert.notInclude(JSON.stringify(response), KEY);
    const frame = Schema.encodeSync(json(ConnectorsEvent))({
      _tag: "changed",
      upsert: added,
      remove: [],
    });
    assert.notInclude(JSON.stringify(frame), KEY);
  });

  it("is never printed by a refusal of the request that carries it", () => {
    const refused = [
      // A name too long, beside a key in the address.
      { ...byAddress, name: "x".repeat(500) },
      // An address with a space, which the key makes it carry.
      { ...byAddress, url: `https://mcp.example.com/mcp?api_key=${KEY} x` },
      // An argument with a NUL, which would end it early.
      { ...byCommand, args: [`--api-key=${KEY}\0--other`] },
    ];
    for (const source of refused) {
      const exit = Schema.decodeExit(json(ConnectorSource))(source);
      assert.isTrue(Exit.isFailure(exit));
      assert.notInclude(String(exit), KEY);
    }
  });
});

describe("a sign-in's address", () => {
  const STATE = "state-sentinel-never-shown";
  const started = (authorizationUrl: string) =>
    Schema.decodeExit(json(SignInStarted))({
      authorizationUrl,
      expiresAt: "2026-11-23T10:10:00.000Z",
    });

  it("opens only at an https: address, and a refused one never prints its state", () => {
    const opened = started(`https://auth.example.com/authorize?state=${STATE}&code_challenge=x`);
    assert.isTrue(Exit.isSuccess(opened));
    assert.notInclude(String(opened), STATE);
    for (const refused of [
      `http://auth.example.com/authorize?state=${STATE}`,
      `javascript:alert(1)//?state=${STATE}`,
      `file:///etc/passwd?state=${STATE}`,
      `j3bots://sign-in?state=${STATE}`,
      `https://auth.example.com/authorize?state=${STATE}&x=${"a".repeat(8_000)}`,
    ]) {
      const exit = started(refused);
      assert.isTrue(Exit.isFailure(exit), refused.slice(0, 40));
      assert.notInclude(String(exit), STATE);
    }
  });
});

describe("a connector card", () => {
  const placed = (n: number) => ({
    id: `e${n}`,
    order: n,
    createdAt: `2026-11-23T10:0${n}:00.000Z`,
  });
  const suggestion = {
    _tag: "connector-suggestion",
    ...placed(1),
    author: { _tag: "bot", botId: "b1" },
    subject: { _tag: "listing", ref: { _tag: "registry", name: "com.example/tracker" } },
    name: "Tracker",
    glyph: null,
    reason: "To read the open issues you asked about.",
    status: { _tag: "connected", connectorId: "conn_0123456789abcdef" },
  };
  const auth = {
    _tag: "connector-auth",
    ...placed(2),
    author: { _tag: "bot", botId: "b1" },
    connectorId: "conn_0123456789abcdef",
    name: "Notion",
    glyph: "notion",
    status: "pending",
  };

  it("reaches a client of this build as the server wrote it", () => {
    const Entries = json(Schema.Array(ReceivedEntry));
    const decoded = Schema.decodeSync(Entries)([suggestion, auth]);
    assert.deepStrictEqual(
      decoded.map((entry) => entry._tag),
      ["connector-suggestion", "connector-auth"],
    );
    assert.deepStrictEqual(Schema.encodeSync(Entries)(decoded), [suggestion, auth]);
  });

  it("is never authored by anyone but a bot", () => {
    const authBy = Schema.decodeExit(json(ConnectorAuthEntry));
    const suggestionBy = Schema.decodeExit(json(ConnectorSuggestionEntry));
    assert.isTrue(Exit.isFailure(authBy({ ...auth, author: { _tag: "system" } })));
    assert.isTrue(Exit.isFailure(suggestionBy({ ...suggestion, author: { _tag: "operator" } })));
  });

  it("reads as an entry it cannot show, in its place, to a client from before connectors", () => {
    // How a client of protocol 7 decodes an entry: the kinds it knew, then
    // anything else by its kind and its place.
    const before = [
      MessageEntry,
      QuestionEntry,
      ApprovalEntry,
      SecretRequestEntry,
      WorkFoldEntry,
      ReceivedNoticeEntry,
      HandoffEntry,
      RoutineChangeEntry,
    ];
    const Unknown = Schema.Struct({
      _tag: UnknownLiteral(before.map((member) => member.fields._tag.schema.literal)),
      id: EntryId,
      order: EntryOrder,
      createdAt: Schema.DateTimeUtc,
    });
    const OlderEntries = json(Schema.Array(Schema.Union([...before, Unknown])));
    const written = Schema.encodeSync(json(Schema.Array(ReceivedEntry)))(
      Schema.decodeSync(json(Schema.Array(ReceivedEntry)))([suggestion, auth]),
    );
    const read = Schema.decodeSync(OlderEntries)(written);
    assert.deepStrictEqual(
      read.map((entry) => [entry._tag, entry.id, entry.order]),
      [
        ["connector-suggestion", "e1", 1],
        ["connector-auth", "e2", 2],
      ],
    );
  });
});
