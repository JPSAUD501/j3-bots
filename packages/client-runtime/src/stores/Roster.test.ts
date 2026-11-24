// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type BotState,
  EntryId,
  ModelId,
  ProviderId,
  type RosterItem,
} from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { rosterRows } from "./Roster.ts";

const NOW = DateTime.makeUnsafe("2026-11-20T12:00:00Z");

const bot = (
  name: string,
  options: {
    readonly minutesAgo: number;
    readonly pinned?: boolean;
    readonly hidden?: boolean;
    readonly unread?: boolean;
    readonly state?: BotState;
  },
): RosterItem => ({
  _tag: "bot",
  bot: {
    id: BotId.make(name),
    profile: { name, title: "", avatar: { shape: "dome", color: "cobalt" }, job: "" },
    model: { providerId: ProviderId.make("claude"), modelId: ModelId.make("opus") },
    permissionMode: "auto",
    primary: false,
    browser: false,
    vault: false,
    pinned: options.pinned ?? false,
    hidden: options.hidden ?? false,
    sectionId: null,
    state: options.state ?? { _tag: "idle" },
    settingsHeld: false,
    opening: false,
    createdAt: DateTime.makeUnsafe(0),
  },
  lastEntry: null,
  lastActivityAt: DateTime.subtract(NOW, { minutes: options.minutesAgo }),
  unread: options.unread ?? false,
});

const names = (rows: ReadonlyArray<RosterItem>) =>
  rows.map((row) => (row._tag === "bot" ? row.bot.profile.name : row.room.name));

it("lists pinned rows first, then the ones waiting on the operator, then the most recent", () => {
  const rows = rosterRows([
    bot("Recent", { minutesAgo: 1 }),
    bot("Old", { minutesAgo: 60 }),
    bot("Asking", {
      minutesAgo: 30,
      state: { _tag: "waiting", entryId: EntryId.make("card"), since: null },
    }),
    bot("Unread", { minutesAgo: 50, unread: true }),
    bot("Pinned", { minutesAgo: 90, pinned: true }),
    bot("Hidden", { minutesAgo: 0, hidden: true, unread: true }),
  ]);

  assert.deepStrictEqual(names(rows), ["Pinned", "Asking", "Unread", "Recent", "Old"]);
});
