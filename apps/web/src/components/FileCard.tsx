// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment } from "@j3-bots/contracts";
import { FileArchiveIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon } from "lucide-react";
import { CARD_PREVIEW_MAX_SIZE, documentKind } from "@j3-bots/client-runtime/documents";
import { fileIcon, showsImage } from "@j3-bots/client-runtime/presentation";
import { fileDetail } from "@j3-bots/client-runtime/wording";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useAttachmentImage } from "./attachmentImages";
import { Blocks, Picture, SheetGrid } from "./documents/DocumentContentView";
import { type DocumentState, factsOfState, useDocument } from "./documents/documents";
import { PdfThumbnail } from "./documents/PdfPages";

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
function PhotoCard({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const { t } = useI18n();
  const image = useAttachmentImage(attachment);
  // Bytes named as an image that do not decode as one show as the file they are.
  const [undrawable, setUndrawable] = useState(false);
  if (image === null || image._tag === "failed" || undrawable) {
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
      {image._tag === "shown" && (
        <img
          src={image.url}
          alt=""
          onError={() => setUndrawable(true)}
          className="size-full object-cover"
        />
      )}
    </button>
  );
}

/**
 * A file a message carries: an image as a photo, a document small enough to
 * fetch as its card with a preview, any other as its card.
 */
export function MessageFile({
  attachment,
  onOpen,
}: {
  attachment: Attachment;
  onOpen: () => void;
}) {
  if (showsImage(attachment)) return <PhotoCard attachment={attachment} onOpen={onOpen} />;
  if (documentKind(attachment) !== null && attachment.size <= CARD_PREVIEW_MAX_SIZE) {
    return <DocumentCard attachment={attachment} onOpen={onOpen} />;
  }
  return <FileCard attachment={attachment} onOpen={onOpen} />;
}

/** Whether `element` is in view now. */
function useInView(element: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry?.isIntersecting === true);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return inView;
}

// The card's width, and its preview's, in CSS pixels.
const CARD_WIDTH = 240;

/**
 * A document a message carries: the top of its first page, or its first
 * rows, above its name and what it is ("PDF, 12 pages"). It is fetched and
 * read as it comes into view, and asked for again when it comes back, in a
 * frame of fixed size, so the conversation
 * never moves as it arrives. Opening it shows it whole.
 */
function DocumentCard({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const card = useRef<HTMLButtonElement>(null);
  // Only while it shows: the page lets go of documents no card in view shows.
  const document = useDocument(attachment, useInView(card));
  return (
    <button
      ref={card}
      type="button"
      onClick={onOpen}
      aria-label={t("file.open", { name: attachment.name })}
      className="pressable flex w-60 max-w-full flex-col overflow-hidden rounded-md border border-border bg-surface text-start transition-colors duration-(--duration-fast) hover:bg-muted"
    >
      <span
        aria-hidden
        className="pointer-events-none relative block h-28 w-full overflow-hidden border-b border-border bg-muted"
      >
        <DocumentPreview state={document} mediaType={attachment.mediaType} />
      </span>
      <span className="flex min-w-0 flex-col px-3 py-2">
        <span className="truncate text-sm font-medium">{attachment.name}</span>
        <span className="text-2xs text-muted-foreground">
          {fileDetail(attachment, i18n, document === null ? undefined : factsOfState(document))}
        </span>
      </span>
    </button>
  );
}

/** A document's first page or rows, small; its kind's icon when it cannot show them. */
function DocumentPreview({ state, mediaType }: { state: DocumentState | null; mediaType: string }) {
  if (state === null || state._tag === "loading") return null;
  const icon = (
    <span className="flex size-full items-center justify-center text-muted-foreground">
      <FileKindIcon mediaType={mediaType} />
    </span>
  );
  switch (state._tag) {
    case "pdf":
      return <PdfThumbnail pdf={state.pdf} width={CARD_WIDTH} />;
    case "content": {
      const { content } = state;
      switch (content._tag) {
        case "text":
          return (
            <pre className="size-full bg-background p-2 font-mono text-[0.5rem] leading-tight whitespace-pre-wrap text-foreground">
              {content.text.slice(0, 800)}
            </pre>
          );
        case "flow":
          return (
            <span className="block size-full bg-background px-3 py-2 text-foreground">
              <span className="block w-[200%] origin-top-left scale-50">
                <Blocks blocks={content.blocks.slice(0, 10)} compact />
              </span>
            </span>
          );
        case "sheets": {
          const [first] = content.sheets;
          return first === undefined ? (
            icon
          ) : (
            <SheetGrid
              compact
              sheet={{
                ...first,
                rows: first.rows.slice(0, 8).map((row) => row.slice(0, 6)),
                columns: Math.min(first.columns, 6),
              }}
            />
          );
        }
        case "slides": {
          const [first] = content.slides;
          const picture = first?.blocks.find((block) => block._tag === "image");
          return first === undefined ? (
            icon
          ) : (
            <span className="flex size-full flex-col gap-1 bg-background p-3 text-foreground">
              {first.title !== null && (
                <span className="line-clamp-2 text-xs font-semibold">{first.title}</span>
              )}
              {picture?._tag === "image" && (
                <Picture image={picture.image} alt="" className="max-h-16 min-h-0 flex-1" />
              )}
            </span>
          );
        }
      }
      return icon;
    }
    default:
      return icon;
  }
}
