// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type Connector, ConnectorId, ConnectorOrigin } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot } from "../../test/fixtures.ts";
import { applyConnectorChange, initialGrant, sameGrant, withBot } from "./connectors.ts";

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
  lastChange: null,
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
  it("starts with the bot it is added for, else every bot", () => {
    expect(initialGrant(bots, scout.id)).toEqual({ _tag: "bots", ids: [scout.id] });
    expect(initialGrant(bots, null)).toEqual({ _tag: "all-bots" });
    // A bot deleted since leaves it to every bot.
    expect(initialGrant(bots, BotId.make("gone"))).toEqual({ _tag: "all-bots" });
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
