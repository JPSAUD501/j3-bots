// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type Room, RoomId } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import { answeringLine } from "./answering.ts";

const [hal, bo, cy, di, gone] = ["hal", "bo", "cy", "di", "gone"].map((id) => BotId.make(id)) as [
  BotId,
  BotId,
  BotId,
  BotId,
  BotId,
];
const names = new Map([
  [hal, "Hal"],
  [bo, "Bo"],
  [cy, "Cy"],
  [di, "Di"],
]);
const nameOf = (id: BotId) => names.get(id);

const room = (answering: ReadonlyArray<BotId>): Room => ({
  id: RoomId.make("launch"),
  name: "Launch",
  status: "active",
  members: [hal, bo, cy, di, gone],
  pinned: false,
  hidden: false,
  createdAt: at("2026-11-01T00:00:00Z"),
  work: answering.length === 0 ? "none" : "running",
  forceStop: false,
  answering,
  memberWork: [],
});

describe("answeringLine", () => {
  const en = createI18n("en");

  it("names whoever answers, first the one answering now", () => {
    expect(answeringLine(room([bo]), nameOf, en)).toEqual({
      faces: [bo],
      text: "Bo is answering…",
    });
    expect(answeringLine(room([bo, hal, cy]), nameOf, en)).toEqual({
      faces: [bo, hal, cy],
      text: "Bo, Hal, and Cy are answering…",
    });
  });

  it("counts the rest past three", () => {
    expect(answeringLine(room([hal, bo, cy, di]), nameOf, en)).toEqual({
      faces: [hal, bo, cy],
      text: "Hal, Bo, and 2 more are answering…",
    });
  });

  it("leaves out a member whose name is not known, and says nothing while nobody answers", () => {
    expect(answeringLine(room([gone, hal]), nameOf, en)?.text).toBe("Hal is answering…");
    expect(answeringLine(room([gone]), nameOf, en)).toBeNull();
    expect(answeringLine(room([]), nameOf, en)).toBeNull();
  });

  it("speaks the operator's language", () => {
    expect(answeringLine(room([hal, bo]), nameOf, createI18n("pt-BR"))?.text).toBe(
      "Hal e Bo estão respondendo…",
    );
  });
});
