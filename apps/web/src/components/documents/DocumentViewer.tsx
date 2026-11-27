// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { fileDetail } from "@j3-bots/client-runtime/wording";
import type { Attachment } from "@j3-bots/contracts";
import { DownloadIcon, FileWarningIcon, XIcon } from "lucide-react";
import { useI18n } from "../../app/context";
import { useHeldWhileClosing } from "../../lib/useHeldWhileClosing";
import { Button } from "../ui/button";
import { DocumentContentView } from "./DocumentContentView";
import { type DocumentState, factsOfState, shownPages, useDocument } from "./documents";
import { PdfPages } from "./PdfPages";

/**
 * A document, over everything, read in the app: a PDF's pages, a Word or
 * Markdown document as its text, a spreadsheet or CSV file as its cells, a
 * presentation as its slides. It opens and closes as the image viewer does:
 * Escape, a click beside it or Close puts it away, and Save keeps a copy.
 */
export function DocumentViewer({
  attachment,
  onClose,
  onSave,
}: {
  /** The file shown; null while none is. */
  attachment: Attachment | null;
  onClose: () => void;
  onSave: (attachment: Attachment) => void;
}) {
  const { held, closed } = useHeldWhileClosing(attachment);
  return (
    <Dialog.Root
      open={attachment !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) closed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-viewer transition-opacity duration-(--duration-state) ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-0 z-40 flex flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-viewer-foreground outline-none transition-opacity duration-(--duration-state) ease-out data-ending-style:opacity-0 data-starting-style:opacity-0">
          {held !== null && (
            <DocumentPane
              key={held.opening}
              attachment={held.value}
              onClose={onClose}
              onSave={onSave}
              inDialog
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The viewer's bar and the document under it, on the viewer's dark canvas.
 * In the viewer's dialog (`inDialog`) its name titles the dialog and Close
 * closes it; the gallery draws it in a frame of its own.
 */
export function DocumentPane({
  attachment,
  onClose,
  onSave,
  inDialog = false,
}: {
  attachment: Attachment;
  onClose: () => void;
  onSave: (attachment: Attachment) => void;
  inDialog?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const document = useDocument(attachment, true);
  const state: DocumentState = document ?? { _tag: "loading" };
  const { name } = attachment;
  const detail = fileDetail(attachment, i18n, factsOfState(state));
  const titleClass = "truncate text-sm font-medium";
  const detailClass = "truncate text-2xs text-viewer-muted-foreground";
  const closeLook = {
    variant: "ghost",
    size: "icon",
    className: "text-viewer-foreground hover:bg-viewer-pressed",
    "aria-label": t("document.close"),
  } as const;
  return (
    <>
      <div className="flex items-center gap-2 p-2 ps-4">
        <div className="flex min-w-0 flex-1 flex-col">
          {inDialog ? (
            <>
              <Dialog.Title className={titleClass}>{name}</Dialog.Title>
              <Dialog.Description className={detailClass}>{detail}</Dialog.Description>
            </>
          ) : (
            <>
              <h2 className={titleClass}>{name}</h2>
              <p className={detailClass}>{detail}</p>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-viewer-foreground hover:bg-viewer-pressed"
          onClick={() => onSave(attachment)}
          aria-label={t("file.save", { name })}
        >
          <DownloadIcon />
        </Button>
        {inDialog ? (
          <Dialog.Close render={<Button {...closeLook} />}>
            <XIcon />
          </Dialog.Close>
        ) : (
          <Button {...closeLook} onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      {/* A click beside the document closes it; one on it does not. */}
      <div
        className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-auto p-2 pt-0 sm:p-4 sm:pt-0"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <Body state={state} attachment={attachment} onSave={onSave} />
      </div>
    </>
  );
}

function Body({
  state,
  attachment,
  onSave,
}: {
  state: DocumentState;
  attachment: Attachment;
  onSave: (attachment: Attachment) => void;
}) {
  const { t } = useI18n();
  switch (state._tag) {
    case "loading":
      return <Status>{t("file.opening")}</Status>;
    case "unreachable":
      return <Status>{t("file.unreachable", { name: attachment.name })}</Status>;
    case "tooBig":
    case "unreadable":
      return (
        <NotShown
          text={t(state._tag === "tooBig" ? "document.tooBig" : "document.unreadable")}
          onSave={() => onSave(attachment)}
        />
      );
    case "pdf":
      return (
        <>
          {shownPages(state.pdf).cut && <Cut />}
          <PdfPages pdf={state.pdf} />
        </>
      );
    case "content": {
      const { content } = state;
      const cut =
        content.cut || (content._tag === "sheets" && content.sheets.some((sheet) => sheet.cut));
      return (
        <>
          {cut && <Cut />}
          <DocumentContentView content={content} />
        </>
      );
    }
  }
}

function Status({ children }: { children: string }) {
  return (
    <p role="status" className="m-auto text-sm text-viewer-muted-foreground">
      {children}
    </p>
  );
}

/** The line above a document that shows only its beginning. */
function Cut() {
  const { t } = useI18n();
  return (
    <p role="note" className="shrink-0 text-center text-xs text-viewer-muted-foreground">
      {t("document.cut")} {t("document.elsewhere.save")}
    </p>
  );
}

/** Why a document does not show here, and the way to see it elsewhere: save it. */
function NotShown({ text, onSave }: { text: string; onSave: () => void }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className="m-auto flex max-w-sm flex-col items-center gap-3 rounded-lg bg-background p-6 text-center text-foreground shadow-overlay"
    >
      <FileWarningIcon className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm">{text}</p>
      <p className="text-sm text-muted-foreground">{t("document.elsewhere.save")}</p>
      <Button variant="primary" onClick={onSave}>
        <DownloadIcon aria-hidden />
        {t("document.saveAction")}
      </Button>
    </div>
  );
}
