// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment } from "@j3-bots/contracts";
import { useI18n } from "../app/context";
import { useAttachmentImage } from "./attachmentImages";
import { FileKindIcon } from "./FileCard";

/**
 * A file where it stands in a message's text: its image or its kind, and its
 * name, in the colors of the bubble it sits in. A click opens it.
 */
export function FileChip({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const { t } = useI18n();
  const image = useAttachmentImage(attachment);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("file.open", { name: attachment.name })}
      title={attachment.name}
      className="mx-0.5 inline-flex h-6 max-w-56 cursor-pointer items-center gap-1 rounded-md border border-current/20 bg-current/10 ps-0.5 pe-1.5 align-middle text-xs leading-none font-medium transition-colors duration-(--duration-fast) hover:bg-current/20 pointer-coarse:h-7 pointer-coarse:text-sm"
    >
      {image?._tag === "shown" ? (
        <img
          src={image.url}
          alt=""
          className="size-5 shrink-0 rounded-sm object-cover pointer-coarse:size-6"
        />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center opacity-75">
          <FileKindIcon mediaType={attachment.mediaType} />
        </span>
      )}
      <span className="truncate">{attachment.name}</span>
    </button>
  );
}
