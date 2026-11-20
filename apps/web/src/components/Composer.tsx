// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DraftFile,
  type FileProblem,
  type MessageProblem,
  messageProblem,
} from "@j3-bots/client-runtime";
import {
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_INLINE_IMAGES_SIZE,
  MAX_MESSAGE_LENGTH,
} from "@j3-bots/contracts";
import { ArrowUpIcon, FileIcon, MicIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useRef, type Ref } from "react";
import { useI18n } from "../app/context";
import type { I18n } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { fileSize } from "./FileCard";
import { Button } from "./ui/button";

interface ComposerProps {
  /** Who the message goes to: a bot's or a room's name. */
  readonly recipient: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** The files in the draft, as they upload. */
  readonly files?: ReadonlyArray<DraftFile>;
  /** The draft is on its way to the outbox, for a few milliseconds: it takes no change. */
  readonly sending?: boolean;
  /** Files the operator picked, pasted or dropped. Without it, the composer takes no files. */
  readonly onAttachFiles?: (files: ReadonlyArray<File>) => void;
  readonly onDetachFile?: (key: string) => void;
  readonly onSend: () => void;
  /** Without it, the trailing button is always Send. */
  readonly onDictate?: () => void;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
}

/** Why a file cannot go, in one sentence. */
function fileProblemText(problem: FileProblem, i18n: I18n): string {
  const { t, locale } = i18n;
  switch (problem) {
    case "empty":
      return t("composer.file.empty");
    case "too-large":
      return t("composer.file.tooLarge", { size: fileSize(MAX_ATTACHMENT_SIZE, locale) });
    case "image-too-large":
      return t("composer.file.imageTooLarge", { size: fileSize(MAX_INLINE_IMAGE_SIZE, locale) });
    case "images-too-large":
      return t("composer.file.imagesTooLarge", { size: fileSize(MAX_INLINE_IMAGES_SIZE, locale) });
    case "too-many":
      return t("composer.file.tooMany", { count: String(MAX_ATTACHMENTS_PER_MESSAGE) });
    case "name-too-long":
      return t("composer.file.nameTooLong");
    case "refused":
      return t("composer.file.refused");
    case "server-setup":
      return t("composer.file.serverSetup");
    case "not-paired":
      return t("composer.file.notPaired");
  }
}

/** Why the message cannot go as it is, in one sentence. */
function messageProblemText(problem: MessageProblem, i18n: I18n): string {
  const { t, locale } = i18n;
  const count = new Intl.NumberFormat(locale);
  switch (problem) {
    case "too-long":
      return t("composer.tooLong", { count: count.format(MAX_MESSAGE_LENGTH) });
    case "too-many-files":
      return t("composer.tooManyFiles", { count: count.format(MAX_ATTACHMENTS_PER_MESSAGE) });
    case "empty-file":
      return t("composer.filesProblem", { reason: fileProblemText("empty", i18n) });
    case "image-too-large":
    case "images-too-large":
      return t("composer.filesProblem", { reason: fileProblemText(problem, i18n) });
  }
}

const nameOf = (file: DraftFile) => (file._tag === "ready" ? file.attachment.name : file.name);

/**
 * The pill at the bottom of a conversation. Enter sends, Shift+Enter starts a
 * new line. Files picked, pasted or dropped upload at once and show above the
 * pill; the message goes once they all have. With nothing to send, the
 * trailing button dictates where dictation exists. A message over a limit
 * of `message.send` is kept, and says why instead of sending. While Send hands
 * the draft over, the field stays focused but read-only, and attaching and
 * removing files show as unavailable. The field draws no ring of its own: the
 * pill takes the focus outline.
 */
export function Composer({
  recipient,
  value,
  onValueChange,
  files = [],
  sending = false,
  onAttachFiles,
  onDetachFile,
  onSend,
  onDictate,
  inputRef,
}: ComposerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const pickerRef = useRef<HTMLInputElement>(null);
  const waitingId = useId();
  const label = t("composer.label", { name: recipient });
  const empty = value.trim() === "" && !files.some((file) => file._tag === "ready");
  const uploading = files.some((file) => file._tag === "uploading");
  const blocked = files.some((file) => file._tag === "failed");
  const problem = messageProblem(
    value.trim(),
    files.flatMap((file) => (file._tag === "ready" ? [file.attachment] : [])),
  );
  const ready = !sending && !empty && !uploading && !blocked && problem === null;
  const send = () => {
    if (ready) onSend();
  };
  const attach = (list: FileList | null) => {
    if (!sending && onAttachFiles && list !== null && list.length > 0) onAttachFiles([...list]);
  };
  const detach = (key: string) => {
    if (!sending) onDetachFile?.(key);
  };
  const failures = files.flatMap((file) =>
    file._tag === "failed"
      ? [
          t("composer.file.failed", {
            name: file.name,
            reason: fileProblemText(file.problem, i18n),
          }),
        ]
      : [],
  );
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      onDragOver={(event) => {
        if (onAttachFiles && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onAttachFiles || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        attach(event.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <ul aria-label={t("composer.files")} className="flex flex-wrap gap-1.5">
          {files.map((file) => (
            <DraftFileChip
              key={file.key}
              file={file}
              onRemove={onDetachFile ? () => detach(file.key) : undefined}
              unavailable={sending}
            />
          ))}
        </ul>
      )}
      {/* Only a file that cannot go is announced; progress is there to see, not to hear. */}
      <p role="status" className="sr-only">
        {failures.join(" ")}
      </p>
      <div className="flex items-end gap-1 rounded-pill border border-input bg-surface p-1 shadow-xs has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-accent">
        {onAttachFiles && (
          <>
            <Button
              variant="ghost-muted"
              size="icon-pill"
              onClick={() => {
                if (!sending) pickerRef.current?.click();
              }}
              aria-disabled={sending}
              aria-label={t("composer.attach")}
            >
              <PlusIcon />
            </Button>
            <input
              ref={pickerRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                attach(event.currentTarget.files);
                // The same file can be picked again after it was removed.
                event.currentTarget.value = "";
              }}
            />
          </>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          readOnly={sending}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          onPaste={(event) => {
            if (!onAttachFiles || event.clipboardData.files.length === 0) return;
            event.preventDefault();
            attach(event.clipboardData.files);
          }}
          placeholder={label}
          aria-label={label}
          data-composer=""
          className="field-sizing-content max-h-(--layout-composer-max-height) min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground pointer-coarse:min-h-(--layout-touch-target) pointer-coarse:py-2.5 pointer-coarse:text-lg"
        />
        {empty && onDictate ? (
          <Button
            variant="ghost-muted"
            size="icon-pill"
            onClick={onDictate}
            aria-label={t("composer.dictate")}
          >
            <MicIcon />
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            size="icon-pill"
            aria-disabled={!ready}
            aria-label={t("composer.send")}
            aria-describedby={uploading ? waitingId : undefined}
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
      <span id={waitingId} hidden>
        {t("composer.stillUploading")}
      </span>
      <p role="alert" className="px-3 text-xs text-blocked empty:hidden">
        {problem === null ? null : messageProblemText(problem, i18n)}
      </p>
    </form>
  );
}

/** A file in the draft: its name, how its upload goes or why it cannot go, and a way out. */
function DraftFileChip({
  file,
  onRemove,
  unavailable,
}: {
  file: DraftFile;
  onRemove: (() => void) | undefined;
  /** The draft is on its way to the outbox: the file cannot be removed meanwhile. */
  unavailable: boolean;
}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const name = nameOf(file);
  const detail = (() => {
    switch (file._tag) {
      case "uploading":
        return t("composer.file.uploading", {
          percent: new Intl.NumberFormat(locale, { style: "percent" }).format(
            file.size === 0 ? 0 : file.sent / file.size,
          ),
        });
      case "ready":
        return fileSize(file.attachment.size, locale);
      case "failed":
        return fileProblemText(file.problem, i18n);
    }
  })();
  return (
    <li
      className={cn(
        "relative flex max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border bg-surface py-1 ps-2 pe-1",
        file._tag === "failed" ? "border-blocked/40 bg-blocked-surface" : "border-border",
      )}
    >
      <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="max-w-48 truncate text-xs font-medium">{name}</span>
        <span
          className={cn(
            "text-2xs tabular-nums",
            file._tag === "failed" ? "text-blocked" : "text-muted-foreground",
          )}
        >
          {detail}
        </span>
      </span>
      {onRemove && (
        <Button
          variant="ghost-muted"
          size="icon-sm"
          onClick={onRemove}
          aria-disabled={unavailable}
          aria-label={t("composer.file.remove", { name })}
        >
          <XIcon />
        </Button>
      )}
      {file._tag === "uploading" && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent transition-transform duration-(--duration-fast)"
          style={{ transform: `scaleX(${file.size === 0 ? 0 : file.sent / file.size})` }}
        />
      )}
    </li>
  );
}
