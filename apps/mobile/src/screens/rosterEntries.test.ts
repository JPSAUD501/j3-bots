// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ArrangedRoster, BotItem } from "@j3-bots/client-runtime/presentation";
import { BotId, ModelId, ProviderId, SectionId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { pinColumns, pinnedHeight, rosterEntries, rosterSizes } from "./rosterEntries.ts";

// The touch scale's lines, `text-base` and `text-sm`, at the default font size.
const sizes = rosterSizes({ base: 22, sm: 22 });

const bot = (name: string): BotItem => ({
  _tag: "bot",
  bot: {
    id: BotId.make(name),
    profile: { name, title: "", avatar: { shape: "dome", color: "cobalt" }, job: "" },
    model: { providerId: ProviderId.make("claude"), modelId: ModelId.make("opus") },
    permissionMode: "auto",
    primary: false,
    pinned: false,
    hidden: false,
    sectionId: null,
    state: { _tag: "idle" },
    settingsHeld: false,
    opening: false,
    browser: false,
    createdAt: DateTime.makeUnsafe(0),
  },
  lastEntry: null,
  lastActivityAt: null,
  unread: false,
});

const arranged = (parts: Partial<ArrangedRoster>): ArrangedRoster => ({
  pinned: [],
  main: [],
  sections: [],
  hidden: [],
  ...parts,
});

describe("the pinned band", () => {
  it("fits as many bots on a line as the width gives each room for a name", () => {
    expect(pinColumns(412)).toBe(4);
    expect(pinColumns(280)).toBe(3);
  });

  it("grows by a line for each line of bots, and takes no room with none", () => {
    const band = (count: number) => pinnedHeight(count, 4, sizes.pinCell);
    expect(band(0)).toBe(0);
    expect(band(1)).toBe(band(4));
    expect(band(5)).toBe(band(8));
    expect(band(5)).toBeGreaterThan(band(4));
  });
});

describe("rosterSizes", () => {
  it("keeps the design's heights at the default font size", () => {
    expect(sizes).toEqual({ row: 64, section: 48, empty: 40, hidden: 56, pinCell: 94 });
  });

  it("grows each entry with its text at a larger font size, never below the design", () => {
    const large = rosterSizes({ base: 40, sm: 38 });
    expect(large.row).toBe(40 + 2 + 38 + 18);
    expect(large.section).toBe(38 + 26);
    expect(large.pinCell).toBe(64 + 8 + 38);
    expect(rosterSizes({ base: 18, sm: 17 })).toMatchObject({ row: 64, section: 48, hidden: 56 });
  });
});

describe("rosterEntries", () => {
  it("lists the band first, even empty, then the rows, then the way to the hidden bots", () => {
    const entries = rosterEntries(
      arranged({ pinned: [bot("Ada")], main: [bot("Bo"), bot("Cy")], hidden: [bot("Di")] }),
      412,
      new Set(),
      sizes,
    );
    expect(entries.map((entry) => entry.key)).toEqual(["pinned", "bot:Bo", "bot:Cy", "hidden"]);
    const unhidden = rosterEntries(arranged({ main: [bot("Bo")] }), 412, new Set(), sizes);
    expect(unhidden.map((entry) => entry.key)).toEqual(["pinned", "bot:Bo"]);
  });

  it("lists each section after the main rows: its bots, the empty line, or only its header when folded, which still says something is unread", () => {
    const work = { id: SectionId.make("work"), name: "Work" };
    const home = { id: SectionId.make("home"), name: "Home" };
    const trips = { id: SectionId.make("trips"), name: "Trips" };
    const entries = rosterEntries(
      arranged({
        main: [bot("Bo")],
        sections: [
          { section: work, items: [bot("Cy"), bot("Di")] },
          { section: home, items: [] },
          { section: trips, items: [{ ...bot("Ed"), unread: true }] },
        ],
      }),
      412,
      new Set([trips.id]),
      sizes,
    );
    expect(entries.map((entry) => entry.key)).toEqual([
      "pinned",
      "bot:Bo",
      "section:work",
      "bot:Cy",
      "bot:Di",
      "section:home",
      "empty:home",
      "section:trips",
    ]);
    expect(entries.at(-1)).toMatchObject({ kind: "section", count: 1, folded: true, unread: true });
  });
});
