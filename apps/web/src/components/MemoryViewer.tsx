// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { MemoryEdit, Save } from "@j3-bots/client-runtime";
import { type MemoryReading, useMemoryEdit } from "@j3-bots/client-runtime/react";
import { memoryEditProblemText } from "@j3-bots/client-runtime/wording";
import { useI18n } from "../app/context";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import { Button } from "./ui/button";
import { dialogBackdrop, screenDialog } from "./ui/dialog";
import { cn } from "../lib/cn";
import { textField } from "./ui/field";

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
   * Reads the file again, after it changed on the server, and resolves with
   * whether the read succeeded. The conflict holds, and the edit stays, until
   * it does.
   */
  readonly onLoadNewer: () => Promise<boolean>;
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
  const i18n = useI18n();
  const { t } = i18n;
  const edit = useMemoryEdit({ reading, save, connected, onLoadNewer });
  const { document, text, saving, reloading, problem } = edit;

  // The text takes focus when an edit starts, and Edit file gets it back when the edit ends.
  const isEditing = text !== undefined;
  const textArea = useRef<HTMLTextAreaElement>(null);
  const alertId = useId();
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
        if (edit.toSave !== null) onSave(edit.toSave);
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border ps-4 pe-2">
        <h2 id={titleId} className="display-type truncate text-lg">
          {title}
        </h2>
        {document !== null && text === undefined && (
          <Button ref={editButton} size="sm" className="ms-auto" onClick={edit.startEdit}>
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
            readOnly={saving || reloading}
            aria-label={t("memory.text", { file: title })}
            aria-invalid={edit.tooLong || undefined}
            aria-describedby={edit.tooLong ? alertId : undefined}
            onChange={(event) => edit.changeText(event.currentTarget.value)}
            className={cn(textField, pre, "min-h-0 flex-1 resize-none p-3")}
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
          {/* Exposed while empty, so a problem that arrives later is announced. */}
          <p id={alertId} role="alert" className="text-xs text-blocked empty:sr-only">
            {problem === null ? null : memoryEditProblemText(problem, i18n)}
          </p>
          {!connected && (
            <p className="text-xs text-muted-foreground">{t("settings.save.offline")}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {edit.stale && (
              <Button
                className="me-auto"
                onClick={edit.loadNewer}
                aria-disabled={reloading || !connected}
              >
                {reloading
                  ? t("memory.loadNewer.loading")
                  : edit.reloadFailed
                    ? t("memory.loadNewer.retry")
                    : t("memory.loadNewer")}
              </Button>
            )}
            <Button
              onClick={() => {
                if (saving) return;
                edit.endEdit();
                onDiscard();
              }}
              aria-disabled={saving}
            >
              {t("memory.cancel")}
            </Button>
            <Button type="submit" variant="primary" aria-disabled={edit.toSave === null}>
              {saving ? t("memory.saving") : t("memory.save")}
            </Button>
          </div>
        </footer>
      )}
    </form>
  );
}

interface MemoryViewerProps extends Omit<
  MemoryFileProps,
  "title" | "reading" | "titleId" | "onEditingChange"
> {
  /** The file open in the viewer, as state holds it; null closes the viewer. */
  readonly file: { readonly title: string; readonly reading: MemoryReading } | null;
  /**
   * Whether the view holds an edit, as it reports through `onEditingChange`.
   * Held by the owner, which keeps a view with an edit open.
   */
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => void;
}

/** `MemoryFile` as a dialog: the whole screen on a phone, a sheet over the app on wider ones. */
export function MemoryViewer({
  file,
  onClose,
  editing,
  onEditingChange,
  ...view
}: MemoryViewerProps) {
  const titleId = useId();
  const { held, closed } = useHeldWhileClosing(file);
  return (
    <Dialog.Root
      open={file !== null}
      // A click outside does not throw away an edit; Escape and the close button still close.
      disablePointerDismissal={editing}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) closed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-2xl`}
        >
          {/* Mounted afresh with each opening, so it starts from the file as read. */}
          {held !== null && (
            <MemoryFile
              key={held.opening}
              title={held.value.title}
              reading={held.value.reading}
              onClose={onClose}
              onEditingChange={onEditingChange}
              titleId={titleId}
              {...view}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
