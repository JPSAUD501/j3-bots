// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryTarget } from "@j3-bots/contracts";

/** Whether two targets are the same conversation or the same room. */
export const sameTarget = (a: EntryTarget, b: EntryTarget): boolean =>
  a._tag === "conversation"
    ? b._tag === "conversation" && a.botId === b.botId
    : b._tag === "room" && a.roomId === b.roomId;
