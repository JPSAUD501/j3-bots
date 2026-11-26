// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { Attachment } from "@j3-bots/contracts";
import { DownloadIcon, XIcon } from "lucide-react";
import { useI18n } from "../app/context";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import { type ImageSource, useImage } from "./attachmentImages";
import { Button } from "./ui/button";

/**
 * An image, over everything, as large as the window lets it be without
 * cropping: a file's, or one a bot looked at while it worked. Escape, a click
 * beside it or Close puts it away; a file's Save keeps a copy of it.
 */
export function ImageViewer({
  image,
  onClose,
  onSave,
}: {
  /** The image shown; null while none is. */
  image: ImageSource | null;
  onClose: () => void;
  onSave: (attachment: Attachment) => void;
}) {
  const { held, closed } = useHeldWhileClosing(image);
  return (
    <Dialog.Root
      open={image !== null}
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
            <Shown key={held.opening} source={held.value} onClose={onClose} onSave={onSave} />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Shown({
  source,
  onClose,
  onSave,
}: {
  source: ImageSource;
  onClose: () => void;
  onSave: (attachment: Attachment) => void;
}) {
  const { t } = useI18n();
  const image = useImage(source);
  const name = source._tag === "file" ? source.attachment.name : t("work.image.title");
  return (
    <>
      <div className="flex items-center gap-2 p-2 ps-4">
        <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">{name}</Dialog.Title>
        {source._tag === "file" && (
          <Button
            variant="ghost"
            size="icon"
            className="text-viewer-foreground hover:bg-viewer-pressed"
            onClick={() => onSave(source.attachment)}
            aria-label={t("file.save", { name })}
          >
            <DownloadIcon />
          </Button>
        )}
        <Dialog.Close
          render={
            <Button
              variant="ghost"
              size="icon"
              className="text-viewer-foreground hover:bg-viewer-pressed"
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
            alt={name}
            className="max-h-full max-w-full rounded-md object-contain shadow-overlay"
          />
        ) : (
          <p role="status" className="text-sm text-viewer-muted-foreground">
            {image?._tag === "failed"
              ? source._tag === "file"
                ? t("file.unreachable", { name })
                : t("work.image.unavailable")
              : t("file.opening")}
          </p>
        )}
      </div>
    </>
  );
}
