// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { Attachment } from "@j3-bots/contracts";
import { DownloadIcon, XIcon } from "lucide-react";
import { useI18n } from "../app/context";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import { useAttachmentImage } from "./attachmentImages";
import { Button } from "./ui/button";

/**
 * An image a file shows, over everything, as large as the window lets it be
 * without cropping. Escape, a click beside it or Close puts it away; Save
 * keeps a copy of the file.
 */
export function ImageViewer({
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
        {/* Dark in both themes, as an image is seen best against it. */}
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/90 transition-opacity duration-(--duration-state) ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-0 z-40 flex flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-white outline-none transition-opacity duration-(--duration-state) ease-out data-ending-style:opacity-0 data-starting-style:opacity-0">
          {held !== null && (
            <Shown key={held.opening} attachment={held.value} onClose={onClose} onSave={onSave} />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Shown({
  attachment,
  onClose,
  onSave,
}: {
  attachment: Attachment;
  onClose: () => void;
  onSave: (attachment: Attachment) => void;
}) {
  const { t } = useI18n();
  const image = useAttachmentImage(attachment);
  return (
    <>
      <div className="flex items-center gap-2 p-2 ps-4">
        <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">
          {attachment.name}
        </Dialog.Title>
        <Button
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/15"
          onClick={() => onSave(attachment)}
          aria-label={t("file.save", { name: attachment.name })}
        >
          <DownloadIcon />
        </Button>
        <Dialog.Close
          render={
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/15"
              aria-label={t("file.viewer.close")}
            />
          }
        >
          <XIcon />
        </Dialog.Close>
      </div>
      {/* A click beside the image closes it; one on the image does not. */}
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {image?._tag === "shown" ? (
          <img
            src={image.url}
            alt={attachment.name}
            className="max-h-full max-w-full rounded-md object-contain shadow-overlay"
          />
        ) : (
          <p role="status" className="text-sm text-white/75">
            {image?._tag === "failed"
              ? t("file.unreachable", { name: attachment.name })
              : t("file.opening")}
          </p>
        )}
      </div>
    </>
  );
}
