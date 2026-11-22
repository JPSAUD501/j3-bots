// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProfileChanges } from "../stores/Settings.ts";
import { Label, type Settings, TimeZone } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { knownTimeZone } from "./time.ts";

/** What the operator changed in the form and has not saved: null for a field they left alone. */
export interface SettingsEdits {
  readonly name: string | null;
  readonly zone: string | null;
}

export const noEdits: SettingsEdits = { name: null, zone: null };

const decodeName = Schema.decodeUnknownOption(Label);
const decodeTimeZone = Schema.decodeUnknownOption(TimeZone);

/** What saving the form would send. */
export type SettingsPatch =
  | { readonly _tag: "unchanged" }
  /**
   * An edit the server would refuse: a name over the length of a label, or a
   * zone this device does not know.
   */
  | { readonly _tag: "invalid"; readonly field: "name" | "zone" }
  | { readonly _tag: "changes"; readonly changes: ProfileChanges };

/**
 * The fields the operator changed from `settings`, and only those, so a save
 * never writes back a value another device changed meanwhile. A name is
 * trimmed, and an empty one clears it. A zone must be one this device knows.
 */
export function settingsPatch(settings: Settings, edits: SettingsEdits): SettingsPatch {
  let changes: ProfileChanges = {};
  if (edits.name !== null) {
    const trimmed = edits.name.trim();
    if (trimmed !== (settings.operatorName ?? "")) {
      const name = trimmed === "" ? Option.some(null) : decodeName(trimmed);
      if (Option.isNone(name)) return { _tag: "invalid", field: "name" };
      changes = { ...changes, operatorName: name.value };
    }
  }
  if (edits.zone !== null) {
    // Saved as the device names it, so a zone typed in another case is the same zone.
    const known = knownTimeZone(edits.zone.trim());
    const zone = known === null ? Option.none() : decodeTimeZone(known);
    if (Option.isNone(zone)) return { _tag: "invalid", field: "zone" };
    if (zone.value !== settings.timeZone) changes = { ...changes, timeZone: zone.value };
  }
  return Object.keys(changes).length === 0 ? { _tag: "unchanged" } : { _tag: "changes", changes };
}

/**
 * The edits after a save of `changes` failed: a field the form holds no edit
 * for takes the value the save sent, so the operator's text is never lost,
 * even in a form opened after the save started.
 */
export function editsAfterFailedSave(edits: SettingsEdits, changes: ProfileChanges): SettingsEdits {
  return {
    name: edits.name ?? (changes.operatorName === undefined ? null : (changes.operatorName ?? "")),
    zone: edits.zone ?? changes.timeZone ?? null,
  };
}
