// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type Connector,
  ConnectorId,
  ConnectorOrigin,
  type ConnectorSuggestionEntry,
  EntryId,
  EntryOrder,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot } from "../../test/fixtures.ts";
import {
  applyConnectorChange,
  initialGrant,
  sameGrant,
  suggestionConnect,
  withBot,
} from "./connectors.ts";

const scout = bot("Scout");
const hal = bot("Hal", { _tag: "idle" }, { primary: true });
const ana = bot("Ana");
const bots = [scout, hal, ana];

const connector = (id: string, name = id): Connector => ({
  id: ConnectorId.make(`conn_${id.padEnd(16, "0")}`),
  name,
  glyph: null,
  publisher: { _tag: "operator" },
  listing: null,
  transport: { _tag: "remote", origin: ConnectorOrigin.make("https://mcp.example.com") },
  signIn: "none",
  fields: [],
  status: { _tag: "connected" },
  grant: { _tag: "all-bots" },
  account: null,
  signedInAt: null,
  tools: [],
  review: null,
  createdAt: at("2026-11-01T00:00:00Z"),
});

describe("the connectors a device holds", () => {
  it("keeps each where it was, takes changes in place and adds new ones after", () => {
    const [a, b, c] = [connector("a"), connector("b"), connector("c")];
    const renamed = { ...b, name: "Renamed" };
    const added = connector("d");
    expect(applyConnectorChange([a, b, c], [added, renamed], [a.id])).toEqual([renamed, c, added]);
  });

  it("leaves out a connector both changed and removed in one change", () => {
    const a = connector("a");
    expect(applyConnectorChange([], [a], [a.id])).toEqual([]);
  });
});

describe("which bots a connector is for", () => {
  it("starts with the bot that asked, else the primary bot", () => {
    expect(initialGrant(bots, scout.id)).toEqual({ _tag: "bots", ids: [scout.id] });
    expect(initialGrant(bots, null)).toEqual({ _tag: "bots", ids: [hal.id] });
    // A bot deleted since it asked leaves it to the primary bot.
    expect(initialGrant(bots, BotId.make("gone"))).toEqual({ _tag: "bots", ids: [hal.id] });
    expect(initialGrant([scout], null)).toEqual({ _tag: "bots", ids: [] });
  });

  it("takes one bot out of all bots as every other bot there is now", () => {
    expect(withBot({ _tag: "all-bots" }, hal.id, false, bots)).toEqual({
      _tag: "bots",
      ids: [scout.id, ana.id],
    });
    expect(withBot({ _tag: "bots", ids: [scout.id] }, ana.id, true, bots)).toEqual({
      _tag: "bots",
      ids: [scout.id, ana.id],
    });
    // Letting in a bot already in lists it once.
    expect(withBot({ _tag: "bots", ids: [scout.id] }, scout.id, true, bots)).toEqual({
      _tag: "bots",
      ids: [scout.id],
    });
  });

  it("finds two grants the same whatever the order of their bots", () => {
    expect(
      sameGrant(
        { _tag: "bots", ids: [scout.id, hal.id] },
        { _tag: "bots", ids: [hal.id, scout.id] },
      ),
    ).toBe(true);
    expect(sameGrant({ _tag: "all-bots" }, { _tag: "bots", ids: [scout.id, hal.id, ana.id] })).toBe(
      false,
    );
    expect(sameGrant({ _tag: "bots", ids: [scout.id] }, { _tag: "bots", ids: [hal.id] })).toBe(
      false,
    );
  });
});

describe("a bot's suggestion of a connector", () => {
  const suggesting = (subject: ConnectorSuggestionEntry["subject"]): ConnectorSuggestionEntry => ({
    _tag: "connector-suggestion",
    id: EntryId.make("e1"),
    order: EntryOrder.make(1),
    createdAt: at("2026-11-01T00:00:00Z"),
    author: { _tag: "bot", botId: scout.id },
    subject,
    name: "Tracker",
    glyph: null,
    reason: "To read the open issues.",
    status: { _tag: "pending" },
  });

  it("opens a gallery entry's page for the bot that asked, and lets no one in yet", () => {
    const ref = { _tag: "registry", name: "com.example/tracker" } as const;
    expect(suggestionConnect(suggesting({ _tag: "listing", ref }), [], bots)).toEqual({
      letIn: null,
      open: {
        at: { _tag: "listing", ref, name: "Tracker", glyph: null },
        forBot: scout.id,
        suggestion: EntryId.make("e1"),
      },
    });
  });

  it("lets the bot use a connector that works, and opens nothing", () => {
    const tracker = { ...connector("t"), grant: { _tag: "bots", ids: [hal.id] } } as const;
    expect(
      suggestionConnect(
        suggesting({ _tag: "connector", connectorId: tracker.id }),
        [tracker],
        bots,
      ),
    ).toEqual({
      letIn: { connectorId: tracker.id, grant: { _tag: "bots", ids: [hal.id, scout.id] } },
      open: null,
    });
  });

  it("lets the bot in, and opens the page of a connector that waits on the operator", () => {
    const tracker: Connector = {
      ...connector("t"),
      grant: { _tag: "bots", ids: [] },
      status: { _tag: "needs-sign-in", reason: "expired" },
    };
    const { letIn, open } = suggestionConnect(
      suggesting({ _tag: "connector", connectorId: tracker.id }),
      [tracker],
      bots,
    );
    expect(letIn?.grant).toEqual({ _tag: "bots", ids: [scout.id] });
    expect(open?.at).toEqual({
      _tag: "connector",
      connectorId: tracker.id,
      signIn: false,
      added: false,
    });
  });

  it("opens the screen's first page for a connector this device does not hold", () => {
    const gone = ConnectorId.make("conn_gone000000000000");
    expect(
      suggestionConnect(suggesting({ _tag: "connector", connectorId: gone }), [], bots),
    ).toEqual({
      letIn: null,
      open: { at: { _tag: "home" }, forBot: scout.id, suggestion: EntryId.make("e1") },
    });
  });
});
