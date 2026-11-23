// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ArrangedRoster, BotItem } from "@j3-bots/client-runtime/presentation";
import { BotId, ModelId, ProviderId, SectionId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { pinColumns, pinnedHeight, rosterEntries } from "./rosterEntries.ts";

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
    expect(pinnedHeight(0, 4)).toBe(0);
    expect(pinnedHeight(1, 4)).toBe(pinnedHeight(4, 4));
    expect(pinnedHeight(5, 4)).toBe(pinnedHeight(8, 4));
    expect(pinnedHeight(5, 4)).toBeGreaterThan(pinnedHeight(4, 4));
  });
});

describe("rosterEntries", () => {
  it("lists the band first, even empty, then the rows, then the way to the hidden bots", () => {
    const entries = rosterEntries(
      arranged({ pinned: [bot("Ada")], main: [bot("Bo"), bot("Cy")], hidden: [bot("Di")] }),
      412,
      new Set(),
    );
    expect(entries.map((entry) => entry.key)).toEqual(["pinned", "bot:Bo", "bot:Cy", "hidden"]);
    const unhidden = rosterEntries(arranged({ main: [bot("Bo")] }), 412, new Set());
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
