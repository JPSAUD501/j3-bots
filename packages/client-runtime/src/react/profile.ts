// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Settings } from "@j3-bots/contracts";
import { useState } from "react";
import {
  editsAfterFailedSave,
  noEdits,
  type SettingsEdits,
  settingsPatch,
} from "../presentation/settings.ts";
import type { ProfileChanges, SettingsSaves } from "../stores/Settings.ts";

type ProfileSave = SettingsSaves["profile"];

/** What the operator changed in the profile form and has not saved. */
export interface ProfileEdits {
  readonly edits: SettingsEdits;
  readonly edit: (change: Partial<SettingsEdits>) => void;
  /** Lets go of the edits, keeping only what a failed save sent. */
  readonly discard: () => void;
}

/**
 * The profile form's unsaved edits. A client may hold them outside the form,
 * so they outlive it, as the web's do while Settings is closed for the
 * operator. A save that ends saved leaves nothing unsaved; one that failed
 * leaves what it sent, so the operator's text is never lost.
 */
export function useProfileEdits(save: ProfileSave): ProfileEdits {
  const kept = () =>
    save._tag === "failed" ? editsAfterFailedSave(noEdits, save.changes) : noEdits;
  const [edits, setEdits] = useState(kept);
  const [lastSave, setLastSave] = useState(save);
  if (lastSave !== save) {
    setLastSave(save);
    if (save._tag === "saved") setEdits(noEdits);
    if (save._tag === "failed") setEdits((current) => editsAfterFailedSave(current, save.changes));
  }
  return {
    edits,
    edit: (change) => setEdits((current) => ({ ...current, ...change })),
    discard: () => setEdits(kept()),
  };
}

export interface ProfileForm {
  /** What each field shows: the operator's edit, else what is being saved, else the saved value. */
  readonly name: string;
  readonly zone: string;
  /** A save is under way; the form then shows what it sends and takes no edit. */
  readonly saving: boolean;
  /** How the save this form started ended, until the next edit. */
  readonly status: "saved" | "failed" | null;
  /** The zone is not one this device knows, said once the operator left the field or pressed Save. */
  readonly zoneUnknown: boolean;
  /** Whether Save does anything now: it sends the changes, or says what is wrong with them. */
  readonly canSave: boolean;
  readonly editName: (value: string) => void;
  readonly editZone: (value: string) => void;
  /** The operator left the zone's field. */
  readonly checkZone: () => void;
  readonly submit: (send: (changes: ProfileChanges) => void) => void;
}

/**
 * The profile form: what bots call the operator, and the time zone. A save
 * sends only the fields the operator changed. A field the operator left
 * alone shows the saved value as it arrives; one they changed keeps their
 * edit until the form saves it. How a save ended shows only for one this
 * form saw under way.
 */
export function useProfileForm(options: {
  readonly settings: Settings;
  readonly save: ProfileSave;
  readonly profile: ProfileEdits;
  /** Saving takes a connection to the server. */
  readonly connected: boolean;
}): ProfileForm {
  const { settings, save, profile, connected } = options;
  const { edits } = profile;
  const [watching, setWatching] = useState(save._tag === "saving");
  // A zone being typed is not wrong yet: it is checked once the operator leaves it or saves.
  const [zoneChecked, setZoneChecked] = useState(false);
  const saving = save._tag === "saving";
  const sending = saving ? save.changes : null;
  const patch = settingsPatch(settings, edits);
  const edit = (change: Partial<SettingsEdits>) => {
    if (saving) return;
    profile.edit(change);
    setWatching(false);
  };
  return {
    name:
      edits.name ??
      (sending?.operatorName === undefined ? settings.operatorName : sending.operatorName) ??
      "",
    zone: edits.zone ?? sending?.timeZone ?? settings.timeZone,
    saving,
    status: watching && (save._tag === "saved" || save._tag === "failed") ? save._tag : null,
    zoneUnknown: zoneChecked && patch._tag === "invalid" && patch.field === "zone",
    canSave: patch._tag !== "unchanged" && !saving && connected,
    editName: (value) => edit({ name: value }),
    editZone: (value) => {
      setZoneChecked(false);
      edit({ zone: value });
    },
    checkZone: () => setZoneChecked(true),
    submit: (send) => {
      if (saving || !connected) return;
      setZoneChecked(true);
      if (patch._tag !== "changes") return;
      setWatching(true);
      send(patch.changes);
    },
  };
}
