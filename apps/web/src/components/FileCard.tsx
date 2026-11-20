// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment } from "@j3-bots/contracts";
import { FileArchiveIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon } from "lucide-react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";

function FileKindIcon({ mediaType }: { mediaType: string }) {
  const props = { className: "size-4", "aria-hidden": true } as const;
  if (mediaType.startsWith("image/")) return <FileImageIcon {...props} />;
  if (mediaType === "application/pdf" || mediaType.startsWith("text/"))
    return <FileTextIcon {...props} />;
  if (/zip|tar|gzip|compressed/.test(mediaType)) return <FileArchiveIcon {...props} />;
  if (/json|javascript|typescript|xml|yaml/.test(mediaType)) return <FileCodeIcon {...props} />;
  return <FileIcon {...props} />;
}

/** The kind of file in a word, from its media type: "PDF", "PNG", "Text". */
function kindOf(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split(/[+;]/)[0] ?? "";
  if (mediaType.startsWith("text/plain")) return "TXT";
  if (subtype === "vnd.openxmlformats-officedocument.wordprocessingml.document") return "DOCX";
  if (subtype === "vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "XLSX";
  return subtype.length > 0 && subtype.length <= 5 ? subtype.toUpperCase() : "";
}

export function fileSize(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** A file in a conversation: name, kind and size. Opening it shows a preview. */
export function FileCard({
  attachment,
  onOpen,
  className,
}: {
  attachment: Attachment;
  onOpen: () => void;
  className?: string;
}) {
  const { locale, t } = useI18n();
  const kind = kindOf(attachment.mediaType);
  const size = fileSize(attachment.size, locale);
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
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileKindIcon mediaType={attachment.mediaType} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{attachment.name}</span>
        <span className="text-2xs text-muted-foreground">
          {kind === "" ? size : t("file.kindAndSize", { kind, size })}
        </span>
      </span>
    </button>
  );
}
