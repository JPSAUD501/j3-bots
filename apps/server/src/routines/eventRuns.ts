// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { json } from "../persistence/columns.ts";

/**
 * One occurrence of a connector's event as J3 Bots keeps it until a run
 * takes it: its name, when its server says it happened, and its payload as
 * its server sent it, cleaned, as JSON text.
 */
export const EventItem = Schema.Struct({
  name: Schema.String,
  at: Schema.DateTimeUtc,
  data: Schema.String,
});
export type EventItem = typeof EventItem.Type;

/** `EventItem` as `routine_event_pending` stores it. */
export const EventItemJson = json(EventItem);

/**
 * What a run of a routine on a connector's event keeps as its trigger data:
 * the events it was started for, oldest first, and whether some may have
 * been missed before them.
 */
const EventRunData = Schema.Struct({
  events: Schema.Array(EventItem),
  missed: Schema.Boolean,
});

/** `EventRunData` as the `trigger_data` column stores it. */
export const EventRunDataJson = json(EventRunData);
