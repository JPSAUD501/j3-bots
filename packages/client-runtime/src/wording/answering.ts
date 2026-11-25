// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Room } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";

/** The most faces, and names, the line shows before it counts the rest. */
const SHOWN = 3;

/** The line at the end of a room that says who is answering there now. */
export interface AnsweringLine {
  /** The faces it shows, of the first members answering, in their order. */
  readonly faces: ReadonlyArray<BotId>;
  readonly text: string;
}

/**
 * Who is answering in the room now, in the order they take their turns:
 * "Hal is answering…", "Hal and Bo are answering…", and past three, "Hal,
 * Bo and 2 more are answering…". A member whose name is not known, as one
 * deleted meanwhile, is left out. Null while nobody answers, and for an
 * archived room.
 */
export function answeringLine(
  room: Room,
  nameOf: (botId: BotId) => string | undefined,
  { t, locale }: I18n,
): AnsweringLine | null {
  if (room.status !== "active") return null;
  const named = room.answering.flatMap((id) => {
    const name = nameOf(id);
    return name === undefined ? [] : [{ id, name }];
  });
  const [first] = named;
  if (first === undefined) return null;
  const faces = named.slice(0, SHOWN).map((one) => one.id);
  if (named.length === 1) return { faces, text: t("room.answering.one", { name: first.name }) };
  if (named.length <= SHOWN) {
    const names = new Intl.ListFormat(locale, { type: "conjunction" }).format(
      named.map((one) => one.name),
    );
    return { faces, text: t("room.answering.some", { names }) };
  }
  const names = named
    .slice(0, SHOWN - 1)
    .map((one) => one.name)
    .join(", ");
  return { faces, text: t("room.answering.more", { names, count: named.length - (SHOWN - 1) }) };
}
