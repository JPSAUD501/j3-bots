// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MemoryDocument, MemoryText } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { type MemoryEditProblem, shownSaveProblem } from "../presentation/saves.ts";
import type { MemoryEdit as Edit, Save } from "../stores/Details.ts";

/** A memory file as a view has it: still reading, read, or not readable. */
export type MemoryReading =
  | { readonly _tag: "reading" }
  | { readonly _tag: "read"; readonly document: MemoryDocument }
  | { readonly _tag: "failed" };

export interface MemoryEdit {
  /** The file as last read, or null until one read succeeds. */
  readonly document: MemoryDocument | null;
  /** The text being edited, or what is being saved; undefined while the file is only shown. */
  readonly text: string | undefined;
  /** A save is under way; the text then takes no edit. */
  readonly saving: boolean;
  /** The newer version is being read; the text then takes no edit. */
  readonly reloading: boolean;
  readonly problem: MemoryEditProblem | null;
  /** The file changed on the server after the edit started: Save waits for the newer version. */
  readonly stale: boolean;
  /** The newer version could not be read, so loading it is tried again. */
  readonly reloadFailed: boolean;
  /** Whether the text is longer than a memory file may be. */
  readonly tooLong: boolean;
  /** Whether the edit holds text the file does not have. */
  readonly unsaved: boolean;
  /** What Save writes, or null while it cannot. */
  readonly toSave: Edit | null;
  readonly startEdit: () => void;
  readonly changeText: (text: string) => void;
  /** Gives up on the edit, unless a save is under way. */
  readonly endEdit: () => void;
  /** Reads the newer version, which replaces the edit once it is read. */
  readonly loadNewer: () => void;
}

const fits = Schema.is(MemoryText);

/**
 * The edit of one memory file. Save writes over the revision the edit started
 * from, so a file that changed on the server meanwhile is never overwritten:
 * the problem says so, the edit stays, and loading the newer version replaces
 * it. While a save is under way the text takes no edit; a save that fails
 * leaves it in place, and its problem shows until the operator edits again.
 * A new version of the file, saved or read again, ends the edit.
 */
export function useMemoryEdit(options: {
  readonly reading: MemoryReading;
  /** The file's latest write, under way or failed, which may predate this view. */
  readonly save: Save<Edit> | undefined;
  /** Saving and reading take a connection to the server. */
  readonly connected: boolean;
  /**
   * Reads the file again, and resolves with whether the read succeeded. The
   * conflict holds, and the edit stays, until it does.
   */
  readonly onLoadNewer: () => Promise<boolean>;
}): MemoryEdit {
  const { reading, save, connected } = options;
  const document = reading._tag === "read" ? reading.document : null;
  const [editing, setEditing] = useState<Edit | null>(() =>
    save?._tag === "failed" ? save.changes : null,
  );
  // A failure shows until the operator edits again.
  const [failureShown, setFailureShown] = useState(save?._tag === "failed");
  const [lastSave, setLastSave] = useState(save);
  if (lastSave !== save) {
    setLastSave(save);
    if (save?._tag === "failed") {
      setEditing((current) => current ?? save.changes);
      setFailureShown(true);
    }
  }
  // Loading the newer version takes one read at a time, and no edit meanwhile.
  // A read that fails keeps the edit and offers to try again.
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const endEdit = () => {
    setEditing(null);
    setFailureShown(false);
    setReloadFailed(false);
  };
  // A new version of the file, saved or read again, ends the edit. The first
  // read does not: an edit kept from a failed save waits for it. A read that
  // fails in between keeps the edit.
  const [lastRead, setLastRead] = useState(document);
  if (document !== null && lastRead !== document) {
    setLastRead(document);
    if (lastRead !== null) endEdit();
  }

  const saving = save?._tag === "saving";
  const saveProblem = shownSaveProblem(save, !failureShown);
  const tooLong = editing !== null && !fits(editing.text);
  const unsaved = editing !== null && editing.text !== document?.text;
  const canSave =
    editing !== null && saveProblem !== "stale" && !tooLong && !saving && connected && unsaved;

  return {
    document,
    text: saving ? save.changes.text : editing?.text,
    saving,
    reloading,
    problem: tooLong ? "too-long" : reloadFailed ? "reload-failed" : saveProblem,
    stale: saveProblem === "stale",
    reloadFailed,
    tooLong,
    unsaved,
    toSave: canSave ? editing : null,
    startEdit: () => {
      if (document !== null) setEditing({ text: document.text, revision: document.revision });
    },
    changeText: (text) => {
      setEditing((current) => current && { ...current, text });
      setFailureShown(false);
    },
    endEdit: () => {
      if (!saving) endEdit();
    },
    loadNewer: () => {
      if (reloading || !connected) return;
      setReloading(true);
      void options.onLoadNewer().then((read) => {
        setReloading(false);
        // The operator asked for the newer version: it replaces the edit, even
        // when it is the first version this view could read.
        if (read) endEdit();
        else setReloadFailed(true);
      });
    },
  };
}
