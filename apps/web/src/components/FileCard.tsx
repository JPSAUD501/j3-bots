// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment } from "@j3-bots/contracts";
import { FileArchiveIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon } from "lucide-react";
import { fileIcon } from "@j3-bots/client-runtime/presentation";
import { fileDetail } from "@j3-bots/client-runtime/wording";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useAttachmentImage } from "./attachmentImages";

const kindIcons = {
  image: FileImageIcon,
  text: FileTextIcon,
  archive: FileArchiveIcon,
  code: FileCodeIcon,
  other: FileIcon,
} as const;

/** The icon of a file's kind. */
export function FileKindIcon({ mediaType }: { mediaType: string }) {
  const Icon = kindIcons[fileIcon(mediaType)];
  return <Icon className="size-4" aria-hidden />;
}

/**
 * A file in a conversation: its image, or its kind; its name and size.
 * Opening it shows it.
 */
export function FileCard({
  attachment,
  onOpen,
  className,
}: {
  attachment: Attachment;
  onOpen: () => void;
  className?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const image = useAttachmentImage(attachment);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("file.open", { name: attachment.name })}
      className={cn(
        "flex w-64 max-w-full items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-start transition-colors duration-(--duration-fast) hover:bg-muted",
        className,
      )}
    >
      {image?._tag === "shown" ? (
        <img src={image.url} alt="" className="size-10 shrink-0 rounded-md bg-muted object-cover" />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileKindIcon mediaType={attachment.mediaType} />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{attachment.name}</span>
        <span className="text-2xs text-muted-foreground">{fileDetail(attachment, i18n)}</span>
      </span>
    </button>
  );
}

/**
 * An image a message carries, as a photo: large enough to see what it is, in
 * a frame of fixed size, so the conversation never moves as it arrives.
 * Opening it shows it whole. An image that cannot be had shows as its card.
 */
export function PhotoCard({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const { t } = useI18n();
  const image = useAttachmentImage(attachment);
  if (image === null || image._tag === "failed") {
    return <FileCard attachment={attachment} onOpen={onOpen} />;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("file.open", { name: attachment.name })}
      title={attachment.name}
      className="pressable h-44 w-60 max-w-full overflow-hidden rounded-md border border-border bg-muted transition-opacity duration-(--duration-fast) hover:opacity-90"
    >
      {image._tag === "shown" && <img src={image.url} alt="" className="size-full object-cover" />}
    </button>
  );
}
