// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Avatar,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_INLINE_IMAGES_SIZE,
  MAX_MESSAGE_LENGTH,
} from "@j3-bots/contracts";
import { ArrowUpIcon, FileIcon, MicIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  messageProblem,
  type DraftFile,
  type DraftMention,
  type FileProblem,
  type MessageProblem,
} from "@j3-bots/client-runtime";
import {
  draggedText,
  EVERYONE,
  followInput,
  insertMention,
  mentionOptions,
  mentionQuery,
  movedOption,
  type DraggedText,
  type FieldEdit,
  type Mentionable,
  type MentionOption,
} from "@j3-bots/client-runtime/presentation";
import { useI18n } from "../app/context";
import type { I18n } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { AvatarShape } from "./BotAvatar";
import { fileSize } from "./FileCard";
import { Button } from "./ui/button";

/** A room member the composer offers after `@`, drawn by its shape. */
export interface MentionCandidate extends Mentionable {
  readonly avatar: Avatar;
}

interface ComposerProps {
  /** Which draft this is. Files the composer did not take are forgotten when it changes. */
  readonly draftKey: string;
  /** Who the message goes to: a bot's or a room's name. */
  readonly recipient: string;
  readonly value: string;
  /** The mentions picked in `value`. Only a room has any. */
  readonly mentions?: ReadonlyArray<DraftMention>;
  /** The new text, with the picked mentions that still stand in it, moved along with it. */
  readonly onValueChange: (value: string, mentions: ReadonlyArray<DraftMention>) => void;
  /** The files in the draft, as they upload. */
  readonly files?: ReadonlyArray<DraftFile>;
  /** The draft is on its way to the outbox, for a few milliseconds: it takes no change. */
  readonly sending?: boolean;
  /**
   * The drafts of the pairing this device follows now are being read, after
   * another pairing ended: until they show, the draft takes no change.
   */
  readonly loading?: boolean;
  /**
   * The drafts could not be read: the draft takes no change, and says so,
   * until `onRetry` reads them. It resolves with whether it did.
   */
  readonly unread?: { readonly onRetry: () => Promise<boolean> };
  /** The device could not keep the draft as it shows: it is in memory only, and is saved again. */
  readonly notSaved?: boolean;
  /** Files the operator picked, pasted or dropped. Without it, the composer takes no files. */
  readonly onAttachFiles?: (files: ReadonlyArray<File>) => void;
  readonly onDetachFile?: (key: string) => void;
  readonly onSend: () => void;
  /** Without it, the trailing button is always Send. */
  readonly onDictate?: () => void;
  /**
   * Text the operator wrote here was replaced in another tab, and can come
   * back. `revision` changes whenever newer text is replaced, which is
   * announced again.
   */
  readonly replaced?: {
    readonly revision: number;
    readonly onRestore: () => void;
    readonly onDismiss: () => void;
  };
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>;
  /**
   * In a room, its members: typing `@` offers them and `@everyone`, and only
   * a pick mentions one; a name typed or pasted addresses nobody.
   */
  readonly mentionable?: ReadonlyArray<MentionCandidate>;
  /** In a room, who the message wakes as it stands, in one quiet line under the pill. */
  readonly addressee?: string;
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
 * the draft over, or the drafts load or could not be read, the field stays
 * focused but read-only, and attaching and removing files show as
 * unavailable; files dropped or pasted meanwhile are not taken, and the
 * composer asks for them again. Many files scroll within their own list, so
 * the pill and what sits above it stay in view. A draft that could not be
 * read says so above the pill, with a way to read it again: once read, the
 * focus returns to the field; read in vain, it says so again. A draft the
 * device could not keep says so quietly below the pill until it is kept. Text
 * replaced in another tab is offered back above the pill until the operator
 * restores or dismisses it; either way the focus returns to the field. The
 * field draws no ring of its own: the pill takes the focus outline. In a room,
 * `@` opens a list of the members and `@everyone` above the pill: arrow keys
 * move through it, keeping the active option in view, Enter or Tab picks, so
 * a second Enter sends, Escape closes it until the next `@`, and a tap picks
 * without taking the focus from the field. Only a pick mentions a member; a
 * quiet line under the pill says who the message wakes.
 */
export function Composer({
  draftKey,
  recipient,
  value,
  mentions = [],
  onValueChange,
  files = [],
  sending = false,
  loading = false,
  unread,
  notSaved = false,
  onAttachFiles,
  onDetachFile,
  onSend,
  onDictate,
  replaced,
  inputRef,
  mentionable,
  addressee,
}: ComposerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const pickerRef = useRef<HTMLInputElement>(null);
  const ownFieldRef = useRef<HTMLTextAreaElement>(null);
  const fieldRef = inputRef ?? ownFieldRef;
  const waitingId = useId();
  const addresseeId = useId();
  const label = t("composer.label", { name: recipient });
  const empty = value.trim() === "" && !files.some((file) => file._tag === "ready");
  const uploading = files.some((file) => file._tag === "uploading");
  const blocked = files.some((file) => file._tag === "failed");
  const problem = messageProblem(
    value.trim(),
    files.flatMap((file) => (file._tag === "ready" ? [file.attachment] : [])),
  );
  // The draft takes no change while it is handed over, loads, or could not be read.
  const frozen = sending || loading || unread !== undefined;
  const ready = !frozen && !empty && !uploading && !blocked && problem === null;
  // Files dropped or pasted while the draft took no change, which it did not take.
  const [notTaken, setNotTaken] = useState(false);
  // They were not taken for this draft: another conversation's composer does not ask for them.
  const [notTakenFor, setNotTakenFor] = useState(draftKey);
  if (notTakenFor !== draftKey) {
    setNotTakenFor(draftKey);
    setNotTaken(false);
  }
  const send = () => {
    if (ready) onSend();
  };
  // The field's selection as the operator last left it: what an edit replaces.
  const selection = useRef<readonly [number, number] | null>(null);
  const remember = (element: HTMLTextAreaElement) => {
    selection.current = [element.selectionStart, element.selectionEnd];
  };
  // Text being dragged out of the field, with the mentions in it, which a drop back in moves.
  const dragged = useRef<DraggedText | null>(null);
  const mention = useMentionPicker({
    draftKey,
    value,
    mentions,
    onValueChange,
    field: fieldRef,
    members: frozen ? undefined : mentionable,
  });
  // Follows an edit of the field, with the mentions that still stand after it.
  const follow = (field: HTMLTextAreaElement, input: Event) => {
    setNotTaken(false);
    const told = input instanceof InputEvent ? input : null;
    const edit: FieldEdit = {
      before: value,
      after: field.value,
      inputType: told?.inputType ?? null,
      data: told?.data ?? null,
      selection: selection.current,
      now: [field.selectionStart, field.selectionEnd],
    };
    onValueChange(field.value, followInput(edit, mentions, dragged.current));
    remember(field);
    mention.follow(field);
  };
  // React reports no edit that leaves the text as it was, as text pasted over
  // the same text, or the second half of a move WebKit has already made: the
  // field's own event does.
  const followUnchanged = useEffectEvent((input: Event) => {
    const field = fieldRef.current;
    if (field !== null && field.value === value) follow(field, input);
  });
  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    const listener = (input: Event) => followUnchanged(input);
    field.addEventListener("input", listener);
    return () => field.removeEventListener("input", listener);
  }, [fieldRef]);
  const attach = (list: FileList | null) => {
    if (!onAttachFiles || list === null || list.length === 0) return;
    setNotTaken(frozen);
    if (!frozen) onAttachFiles([...list]);
  };
  const detach = (key: string) => {
    if (!frozen) onDetachFile?.(key);
  };
  const focusField = () => fieldRef.current?.focus();
  // The notice leaves with the button that was pressed: the focus goes back to the text.
  const answerReplaced = (answer: () => void) => {
    answer();
    focusField();
  };
  // Each read in vain is a new alert, so it is announced again though the words are the same.
  const [failedReads, setFailedReads] = useState(0);
  const retryRead = (onRetry: () => Promise<boolean>) =>
    void onRetry().then((read) => {
      if (read) focusField();
      else setFailedReads((count) => count + 1);
    });
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
        <ul
          aria-label={t("composer.files")}
          className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto overscroll-contain"
        >
          {files.map((file) => (
            <DraftFileChip
              key={file.key}
              file={file}
              onRemove={onDetachFile ? () => detach(file.key) : undefined}
              unavailable={frozen}
            />
          ))}
        </ul>
      )}
      {/* Drafts that load say nothing: it takes a moment. Drafts that could not be read say so until read. */}
      {unread && !loading && (
        <div className="flex flex-wrap items-center justify-end gap-x-2 ps-3 pe-1 text-xs text-muted-foreground">
          <p key={failedReads} role="alert" className="me-auto py-1">
            {t("composer.unread")}
          </p>
          <Button variant="ghost" size="sm" onClick={() => retryRead(unread.onRetry)}>
            {t("composer.unread.retry")}
          </Button>
        </div>
      )}
      {replaced && (
        <div className="flex flex-wrap items-center justify-end gap-x-2 ps-3 pe-1 text-xs text-muted-foreground">
          <p className="me-auto py-1">{t("composer.replaced")}</p>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!frozen) answerReplaced(replaced.onRestore);
              }}
              aria-disabled={frozen}
            >
              {t("composer.restore")}
            </Button>
            <Button
              variant="ghost-muted"
              size="sm"
              onClick={() => answerReplaced(replaced.onDismiss)}
            >
              {t("composer.dismiss")}
            </Button>
          </div>
        </div>
      )}
      {/* Replaced text is announced each time newer text is replaced: a new node, though the words are the same. */}
      <p role="status" className="sr-only">
        {replaced && <span key={replaced.revision}>{t("composer.replaced")}</span>}
      </p>
      {/* A file that cannot go is announced; progress is there to see, not to hear. */}
      <p role="status" className="sr-only">
        {failures.join(" ")}
      </p>
      {/* Over the conversation, not in the composer's flow, so nothing above it moves. */}
      {mention.open && (
        <div className="relative">
          <MentionList
            id={mention.listId}
            options={mention.options}
            members={mentionable ?? []}
            active={mention.active}
            optionId={mention.optionId}
            onPick={mention.pick}
          />
        </div>
      )}
      <div className="flex items-end gap-1 rounded-pill border border-input bg-surface p-1 shadow-xs has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-accent">
        {onAttachFiles && (
          <>
            <Button
              variant="ghost-muted"
              size="icon-pill"
              onClick={() => {
                if (!frozen) pickerRef.current?.click();
              }}
              aria-disabled={frozen}
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
          ref={fieldRef}
          rows={1}
          value={value}
          readOnly={frozen}
          onChange={(event) => follow(event.currentTarget, event.nativeEvent)}
          onSelect={(event) => {
            remember(event.currentTarget);
            mention.follow(event.currentTarget);
          }}
          onFocus={(event) => {
            remember(event.currentTarget);
            mention.follow(event.currentTarget);
          }}
          onBlur={mention.leave}
          onCut={(event) => remember(event.currentTarget)}
          onDragStart={(event) => {
            const field = event.currentTarget;
            dragged.current = draggedText(
              value,
              [field.selectionStart, field.selectionEnd],
              mentions,
            );
          }}
          onDragEnd={() => {
            dragged.current = null;
          }}
          onDrop={(event) => remember(event.currentTarget)}
          onKeyDown={(event) => {
            remember(event.currentTarget);
            if (mention.onKeyDown(event)) return;
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          onPaste={(event) => {
            remember(event.currentTarget);
            if (!onAttachFiles || event.clipboardData.files.length === 0) return;
            event.preventDefault();
            attach(event.clipboardData.files);
          }}
          placeholder={label}
          aria-label={label}
          aria-describedby={addressee === undefined ? undefined : addresseeId}
          {...mention.fieldProps}
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
      {/* Read with the field, not announced as it changes: it changes with each mention. */}
      {addressee !== undefined && (
        <p id={addresseeId} className="truncate px-3 text-xs text-muted-foreground">
          {addressee}
        </p>
      )}
      {/* Quiet: it clears by itself once the device keeps the draft. */}
      {notSaved && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {t("composer.notSaved")}
        </p>
      )}
      <p role="alert" className="px-3 text-xs text-blocked empty:hidden">
        {/* Files just dropped and not taken come first: the operator is waiting on them now. */}
        {notTaken
          ? t("composer.waitToAttach")
          : problem === null
            ? null
            : messageProblemText(problem, i18n)}
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
  /** The draft takes no change: the file cannot be removed meanwhile. */
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

/**
 * What the composer needs to offer mentions: whether the list is open, what
 * it offers and which option is active, and the field's handlers that follow
 * the caret and the keys. Without `members` it never opens.
 */
function useMentionPicker({
  draftKey,
  value,
  mentions,
  onValueChange,
  field,
  members,
}: {
  draftKey: string;
  value: string;
  mentions: ReadonlyArray<DraftMention>;
  onValueChange: (value: string, mentions: ReadonlyArray<DraftMention>) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  members: ReadonlyArray<Mentionable> | undefined;
}) {
  const listId = useId();
  // Where the caret is while the field has focus; null while it has none.
  const [caret, setCaret] = useState<number | null>(null);
  // The `@` the operator closed the list on, which reopens only at another one.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // Where the caret goes once a pick has reached the field.
  const placeCaret = useRef<number | null>(null);
  // Another draft's caret says nothing about this one: it is followed again from the next edit.
  const [caretFor, setCaretFor] = useState(draftKey);
  if (caretFor !== draftKey) {
    setCaretFor(draftKey);
    setCaret(null);
    setDismissed(null);
  }

  const query =
    members === undefined || caret === null ? null : mentionQuery(value, caret, mentions);
  const options =
    query === null || members === undefined ? [] : mentionOptions(query.query, members);
  const open = query !== null && query.start !== dismissed && options.length > 0;
  // A new query starts at the first option.
  const queryKey = query === null ? null : `${query.start}:${query.query}`;
  const [activeFor, setActiveFor] = useState(queryKey);
  if (activeFor !== queryKey) {
    setActiveFor(queryKey);
    setActive(0);
  }
  const current = Math.min(active, Math.max(options.length - 1, 0));
  const optionId = (index: number) => `${listId}-${index}`;

  useLayoutEffect(() => {
    const at = placeCaret.current;
    const element = field.current;
    if (at === null || element === null || element.value !== value) return;
    placeCaret.current = null;
    element.setSelectionRange(at, at);
    setCaret(at);
  }, [field, value]);

  const pick = (option: MentionOption) => {
    if (query === null || caret === null) return;
    const next = insertMention(value, caret, mentions, query, option);
    const element = field.current;
    // A pick that leaves the text as it was changes nothing in the field: the caret moves now.
    if (next.text === value && element !== null) {
      element.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    } else {
      placeCaret.current = next.caret;
    }
    onValueChange(next.text, next.mentions);
  };

  return {
    open,
    options,
    active: current,
    listId,
    optionId,
    pick,
    /** Follows the caret of the field after an edit, a move or a focus. */
    follow: (element: HTMLTextAreaElement) => {
      setCaret(element.selectionStart === element.selectionEnd ? element.selectionStart : null);
      if (
        dismissed !== null &&
        mentionQuery(element.value, element.selectionStart, mentions)?.start !== dismissed
      ) {
        setDismissed(null);
      }
    },
    leave: () => setCaret(null),
    /** Handles the key when the list is open; true when it took it. */
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open || query === null || event.nativeEvent.isComposing) return false;
      const option = options[current];
      // Arrows with a modifier belong to the shell, which moves through the roster with them.
      const modified = event.altKey || event.ctrlKey || event.metaKey;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !modified) {
        setActive(movedOption(current, event.key === "ArrowDown" ? 1 : -1, options.length));
      } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && option) {
        pick(option);
      } else if (event.key === "Escape") {
        setDismissed(query.start);
      } else {
        return false;
      }
      event.preventDefault();
      return true;
    },
    fieldProps:
      members === undefined
        ? {}
        : ({
            role: "combobox",
            "aria-multiline": true,
            "aria-autocomplete": "list",
            "aria-expanded": open,
            "aria-controls": open ? listId : undefined,
            "aria-activedescendant": open ? optionId(current) : undefined,
          } as const),
  };
}

/** The members and `@everyone` the operator can mention, above the pill. */
export function MentionList({
  id,
  options,
  members,
  active,
  optionId,
  onPick,
}: {
  id: string;
  options: ReadonlyArray<MentionOption>;
  members: ReadonlyArray<MentionCandidate>;
  active: number;
  optionId: (index: number) => string;
  onPick: (option: MentionOption) => void;
}) {
  const { t } = useI18n();
  const avatars = new Map(members.map((member) => [member.id, member.avatar]));
  const listRef = useRef<HTMLUListElement>(null);
  const activeId = optionId(active);
  // The active option stays in view as the keys move through a list longer than it shows.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    for (const option of list.children) {
      if (option.id === activeId) option.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);
  return (
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={t("mention.label")}
      className="absolute start-0 bottom-0 z-10 flex max-h-60 w-full max-w-72 flex-col overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      {options.map((option, index) => {
        const avatar = option._tag === "bot" ? avatars.get(option.id) : undefined;
        return (
          <li
            key={option._tag === "bot" ? option.id : EVERYONE}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            // The field keeps the focus, so the keyboard stays up on a touch screen.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onPick(option)}
            className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm aria-selected:bg-muted pointer-coarse:min-h-(--layout-touch-target)"
          >
            {option._tag === "bot" ? (
              <>
                {avatar && <AvatarShape avatar={avatar} size={20} />}
                <span className="min-w-0 truncate">{option.name}</span>
              </>
            ) : (
              <>
                <UsersIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span>@{EVERYONE}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {t("mention.everyone")}
                </span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
