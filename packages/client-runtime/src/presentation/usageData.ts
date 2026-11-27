// SPDX-License-Identifier: AGPL-3.0-or-later
import { SentTelemetryEvent, type Settings } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import type { SettingsSave, UsageDataChanges } from "../stores/Settings.ts";

/** The page that says what usage data holds, what it never holds, and how to turn it off. */
export const USAGE_DATA_DOCS =
  "https://github.com/JPSAUD501/j3-bots/blob/main/docs/product/usage-data.md";

/**
 * The usage data switch as Settings shows it, or null on a server without
 * usage data. `heldOff`: the server's environment keeps it off, whatever
 * the switch says, so the switch shows off and cannot be turned.
 */
export interface UsageDataSwitch {
  readonly checked: boolean;
  readonly heldOff: boolean;
  readonly saving: boolean;
  readonly failed: boolean;
}

export const usageDataSwitch = (
  settings: Settings | null,
  save: SettingsSave<UsageDataChanges>,
): UsageDataSwitch | null => {
  const telemetry = settings?.telemetry;
  if (telemetry === undefined) return null;
  const saving = save._tag === "saving";
  return {
    checked: !telemetry.heldOff && (saving ? save.changes.enabled : telemetry.enabled),
    heldOff: telemetry.heldOff,
    saving,
    failed: save._tag === "failed",
  };
};

const encodeSent = Schema.encodeSync(Schema.toCodecJson(SentTelemetryEvent));

/** Each event as the JSON it left the server as, indented to be read. */
export const sentAsJson = (events: ReadonlyArray<SentTelemetryEvent>): ReadonlyArray<string> =>
  events.map((event) => JSON.stringify(encodeSent(event), null, 2));
