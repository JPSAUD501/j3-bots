// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ActionState,
  Draft,
  Save,
  SettingsSave,
  SettingsSaves,
} from "@j3-bots/client-runtime";

/** What a restart would cut short, as the client runtime tracks it. */
interface Writes {
  readonly settings: { readonly [Section in keyof SettingsSaves]: SettingsSave<unknown> };
  readonly bots: ReadonlyMap<unknown, Save<unknown>>;
  readonly memory: ReadonlyMap<unknown, Save<unknown>>;
  readonly actions: ReadonlyMap<string, ActionState>;
  readonly drafts: ReadonlyMap<string, Draft>;
  /** Whether a change to a draft is not kept on the device yet. */
  readonly draftsSaving: boolean;
}

/**
 * Whether a save is under way: one the server has not answered (Settings, a
 * bot's profile, a memory file, an answer to a card, a retry, a stop), a
 * draft the device has not kept, a draft moving to the outbox, or a file
 * still uploading. A message already in the outbox is kept on the device and
 * sent after the restart, so it is none.
 */
export const savesUnderWay = (writes: Writes): boolean =>
  Object.values(writes.settings).some((save) => save._tag === "saving") ||
  [...writes.bots.values(), ...writes.memory.values()].some((save) => save._tag === "saving") ||
  [...writes.actions.values()].some((action) => action._tag === "submitting") ||
  writes.draftsSaving ||
  [...writes.drafts.values()].some(
    (draft) => draft.sending || draft.files.some((file) => file._tag === "uploading"),
  );
