// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EventMark } from "@j3-bots/client-runtime/wording";

/** The text color of a mark, by its tone: an event line's status, and a teammate message's marks. */
export const markTone: Record<EventMark["tone"], string> = {
  waiting: "text-waiting",
  blocked: "text-blocked",
  quiet: "text-muted-foreground",
};
