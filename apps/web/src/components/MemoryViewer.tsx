// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { MemoryEdit, Save } from "@j3-bots/client-runtime";
import type { MemoryDocument } from "@j3-bots/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { shownSaveProblem } from "../presentation/saves";
import { Button } from "./ui/button";

/** A memory file as the viewer has it: still reading, read, or not readable. */
export type MemoryReading =
  | { readonly _tag: "reading" }
  | { readonly _tag: "read"; readonly document: MemoryDocument }
  | { readonly _tag: "failed" };

/** The props of the file's view, whatever frames it: the dialog in the app, a pane in the gallery. */
export interface MemoryFileProps {
  /** The file's name as the details list shows it. */
  readonly title: string;
  readonly reading: MemoryReading;
  /** The file's latest write, under way or failed, which may predate this view. */
  readonly save: Save<MemoryEdit> | undefined;
  /** Saving takes a connection to the server. */
  readonly connected: boolean;
  readonly onSave: (edit: MemoryEdit) => void;
  /** The operator gave up on an edit whose save failed. */
  readonly onDiscard: () => void;
  /**
   * Reads the file again, after it changed on the server. The conflict holds,
   * and the edit stays, until the read succeeds.
   */
  readonly onLoadNewer: () => void;
  readonly onClose: () => void;
  /** Told when the view starts and stops holding an edit. */
  readonly onEditingChange?: (editing: boolean) => void;
  /** The id of the view's heading, which names the dialog. */
  readonly titleId: string;
}

const pre = "font-mono text-xs whitespace-pre-wrap wrap-anywhere";

/**
 * One memory file as the bot wrote it, which the operator can correct. Save
 * writes over the revision the edit started from, so a file that changed on
 * the server meanwhile is never overwritten: the view says so, keeps the edit
 * and offers the newer version. While a save is under way the text takes no
 * edit; a save that fails leaves it in place and says why.
 */
export function MemoryFile({
  title,
  reading,
  save,
  connected,
  onSave,
  onDiscard,
  onLoadNewer,
  onClose,
  onEditingChange,
  titleId,
}: MemoryFileProps) {
  const { t } = useI18n();
  const document = reading._tag === "read" ? reading.document : null;
  const [editing, setEditing] = useState<MemoryEdit | null>(() =>
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
  // A new version of the file, saved or read again, ends the edit. The first
  // read does not: an edit kept from a failed save waits for it. A read that
  // fails in between keeps the edit.
  const [lastRead, setLastRead] = useState(document);
  if (document !== null && lastRead !== document) {
    setLastRead(document);
    if (lastRead !== null) {
      setEditing(null);
      setFailureShown(false);
    }
  }

  const saving = save?._tag === "saving";
  const text = saving ? save.changes.text : editing?.text;
  const problem = shownSaveProblem(save, !failureShown);
  const reloadFailed = problem === "stale" && reading._tag === "failed";
  const canSave =
    editing !== null &&
    problem !== "stale" &&
    !saving &&
    connected &&
    (document === null || editing.text !== document.text);

  // The text takes focus when an edit starts, and Edit file gets it back when the edit ends.
  const isEditing = text !== undefined;
  const textArea = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(isEditing);
  useEffect(() => {
    if (wasEditing.current === isEditing) return;
    wasEditing.current = isEditing;
    (isEditing ? textArea : editButton).current?.focus();
  }, [isEditing]);
  useEffect(() => {
    if (!isEditing || onEditingChange === undefined) return;
    onEditingChange(true);
    return () => onEditingChange(false);
  }, [isEditing, onEditingChange]);

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (editing === null || !canSave) return;
        onSave(editing);
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border ps-4 pe-2">
        <h2 id={titleId} className="truncate text-sm font-medium">
          {title}
        </h2>
        {document !== null && text === undefined && (
          <Button
            ref={editButton}
            size="sm"
            className="ms-auto"
            onClick={() => setEditing({ text: document.text, revision: document.revision })}
          >
            {t("memory.edit")}
          </Button>
        )}
        <Button
          variant="ghost-muted"
          size="icon"
          className={text === undefined && document !== null ? "" : "ms-auto"}
          onClick={onClose}
          aria-label={t("memory.close")}
        >
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {text !== undefined ? (
          <textarea
            ref={textArea}
            value={text}
            readOnly={saving}
            aria-label={t("memory.text", { file: title })}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setEditing((current) => current && { ...current, text: value });
              setFailureShown(false);
            }}
            className={`${pre} min-h-0 flex-1 resize-none rounded-md border border-input bg-surface p-3 focus-visible:outline-2 focus-visible:outline-accent read-only:text-muted-foreground`}
          />
        ) : reading._tag === "reading" ? (
          <p className="text-xs text-muted-foreground">{t("details.loading")}</p>
        ) : reading._tag === "failed" ? (
          <p role="alert" className="text-sm text-blocked">
            {t("memory.readFailed")}
          </p>
        ) : (
          <pre className={pre}>{reading.document.text}</pre>
        )}
      </div>
      {text !== undefined && (
        <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
          <p role="alert" className="text-xs text-blocked empty:hidden">
            {reloadFailed
              ? t("memory.reloadFailed")
              : problem === null
                ? null
                : t(problemText[problem])}
          </p>
          {!connected && (
            <p className="text-xs text-muted-foreground">{t("settings.save.offline")}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {problem === "stale" && (
              <Button className="me-auto" onClick={onLoadNewer}>
                {reloadFailed ? t("memory.loadNewer.retry") : t("memory.loadNewer")}
              </Button>
            )}
            <Button
              onClick={() => {
                if (saving) return;
                setEditing(null);
                setFailureShown(false);
                onDiscard();
              }}
              aria-disabled={saving}
            >
              {t("memory.cancel")}
            </Button>
            <Button type="submit" variant="primary" aria-disabled={!canSave}>
              {saving ? t("memory.saving") : t("memory.save")}
            </Button>
          </div>
        </footer>
      )}
    </form>
  );
}

const problemText = {
  stale: "memory.stale",
  "private-location": "memory.privateLocation",
  gone: "memory.gone",
  model: "memory.saveFailed",
  failed: "memory.saveFailed",
} as const;

interface MemoryViewerProps extends Omit<MemoryFileProps, "title" | "titleId" | "onEditingChange"> {
  /** The file's name as the details list shows it. Null closes the viewer. */
  readonly title: string | null;
}

/** `MemoryFile` as a dialog: the whole screen on a phone, a sheet over the app on wider ones. */
export function MemoryViewer({ title, onClose, ...view }: MemoryViewerProps) {
  const titleId = useId();
  // A click outside does not throw away an edit; Escape and the close button still close.
  const [editing, setEditing] = useState(false);
  return (
    <Dialog.Root
      open={title !== null}
      disablePointerDismissal={editing}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-labelledby={titleId}
          className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground outline-none transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0 tablet:inset-x-4 tablet:top-12 tablet:bottom-12 tablet:mx-auto tablet:max-w-2xl tablet:rounded-lg tablet:border tablet:border-border tablet:shadow-xl"
        >
          {/* Mounted with the popup, so each opening starts from the file as read. */}
          {title !== null && (
            <MemoryFile
              title={title}
              onClose={onClose}
              onEditingChange={setEditing}
              titleId={titleId}
              {...view}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
