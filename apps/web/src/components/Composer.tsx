// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment, Avatar } from "@j3-bots/contracts";
import { ArrowUpIcon, MicIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { DraftFile, DraftMention } from "@j3-bots/client-runtime";
import { useRestored } from "@j3-bots/client-runtime/react";
import {
  draftFileName,
  draftReadiness,
  draggedText,
  EVERYONE,
  insertMention,
  markCount,
  mentionOptions,
  mentionQuery,
  movedOption,
  type DraggedText,
  type Mentionable,
  type MentionOption,
} from "@j3-bots/client-runtime/presentation";
import { useI18n } from "../app/context";
import {
  draftFileDetail,
  fileProblemText,
  messageProblemText,
} from "@j3-bots/client-runtime/wording";
import { springs } from "@j3-bots/design-tokens";
import { cn } from "../lib/cn";
import { play } from "../lib/motion";
import { type FieldInput, followFieldInput } from "../lib/fieldEdit";
import { useAttachmentImage } from "./attachmentImages";
import { BotAvatar } from "./avatar/BotAvatar";
import {
  ChipField,
  dropOffset,
  type FieldChange,
  fieldSelection,
  fieldText,
  selectInField,
} from "./ChipField";
import { FileKindIcon } from "./FileCard";
import { Button } from "./ui/button";

/**
 * The send button's three looks: nothing to send yet, a message ready to go,
 * and one on its way.
 */
type SendState = "disabled" | "ready" | "sending";

const sendButton = cn(
  "border-0 aria-disabled:opacity-100",
  "data-[send=disabled]:bg-muted data-[send=disabled]:text-muted-foreground",
  "data-[send=ready]:bg-(--tint) data-[send=ready]:text-avatar-ink data-[send=ready]:hover:bg-[color-mix(in_oklab,var(--tint)_85%,var(--background))]",
  "data-[send=sending]:bg-(--tint) data-[send=sending]:text-avatar-ink",
);

/** A room member the composer offers after `@`, drawn by its shape. */
export interface MentionCandidate extends Mentionable {
  readonly avatar: Avatar;
}

interface ComposerProps {
  /** Which draft this is. Files the composer did not take are forgotten when it changes. */
  readonly draftKey: string;
  /** Who the message goes to: a bot's or a room's name. */
  readonly recipient: string;
  /** The draft's text, with a mark where each of its files stands. */
  readonly value: string;
  /** The mentions picked in `value`. Only a room has any. */
  readonly mentions?: ReadonlyArray<DraftMention>;
  /**
   * The new text, with the picked mentions that still stand in it, moved along
   * with it, and the keys of the files it still places, in their new order,
   * when that changed.
   */
  readonly onValueChange: (
    value: string,
    mentions: ReadonlyArray<DraftMention>,
    order?: ReadonlyArray<string>,
  ) => void;
  /** The files in the draft, as they upload, in the order of their marks. */
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
  /**
   * Files the operator picked, pasted or dropped, to place at `at` in the
   * text, or after it. Without it, the composer takes no files.
   */
  readonly onAttachFiles?: (files: ReadonlyArray<File>, at?: number) => void;
  readonly onDetachFile?: (key: string) => void;
  /** Opens a file of the draft the server already holds. */
  readonly onOpenFile?: (attachment: Attachment) => void;
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
  readonly inputRef?: RefObject<HTMLDivElement | null>;
  /**
   * In a room, its members: typing `@` offers them and `@everyone`, and only
   * a pick mentions one; a name typed or pasted addresses nobody.
   */
  readonly mentionable?: ReadonlyArray<MentionCandidate>;
}

/**
 * The composer at the bottom of a conversation: a rounded rectangle that
 * grows with its text. Enter sends, Shift+Enter starts a new line. Files
 * picked, pasted or dropped upload at once and stand in the text as chips:
 * where the caret was, or where they were dropped. A chip shows its image or
 * its kind, and its name; it is deleted as one character, and a click opens
 * its file once uploaded. A file that cannot go says why below the composer.
 * The message goes once every file has uploaded. With nothing to send, the
 * trailing button dictates where dictation exists. A message over a limit
 * of `message.send` is kept, and says why instead of sending. While Send hands
 * the draft over, or the drafts load or could not be read, the field stays
 * focused but read-only, and attaching and removing files show as
 * unavailable; files dropped or pasted meanwhile are not taken, and the
 * composer asks for them again. A draft that could not be
 * read says so above the composer, with a way to read it again: once read, the
 * focus returns to the field; read in vain, it says so again. A draft the
 * device could not keep says so quietly below the composer until it is kept. Text
 * replaced in another tab is offered back above the composer until the operator
 * restores or dismisses it; either way the focus returns to the field. The
 * field draws no ring of its own: while anything in it has focus, the composer
 * takes a calm border and halo in the conversation's tint. In a room,
 * `@` opens a list of the members and `@everyone` above the composer: arrow keys
 * move through it, keeping the active option in view, Enter or Tab picks, so
 * a second Enter sends, Escape closes it until the next `@`, and a tap picks
 * without taking the focus from the field. Only a pick mentions a member; a
 * quiet line under the composer says who the message wakes.
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
  onOpenFile,
  onSend,
  onDictate,
  replaced,
  inputRef,
  mentionable,
}: ComposerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const pickerRef = useRef<HTMLInputElement>(null);
  const ownFieldRef = useRef<HTMLDivElement>(null);
  const fieldRef = inputRef ?? ownFieldRef;
  const waitingId = useId();
  const label = t("composer.label", { name: recipient });
  const { empty, uploading, sendable, problem } = draftReadiness(value, files);
  // The draft takes no change while it is handed over, loads, or could not be read.
  const frozen = sending || loading || unread !== undefined;
  // Files the draft already held when shown appear in place; only those attached since arrive.
  const restored = useRestored(
    draftKey,
    files.map((file) => file.key),
    loading || unread !== undefined,
  );
  const ready = !frozen && sendable;
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
  const sendState: SendState = sending ? "sending" : ready ? "ready" : "disabled";
  // Once the draft is handed over and the field is clear, the composer settles back with a pop.
  const boxRef = useRef<HTMLDivElement>(null);
  const wasSending = useRef(sending);
  useEffect(() => {
    const handedOver = wasSending.current && !sending;
    wasSending.current = sending;
    if (handedOver && boxRef.current !== null) {
      play(boxRef.current, [{ transform: "scale(0.97)" }, { transform: "none" }], springs.pop);
    }
  }, [sending]);
  // The field's selection as the operator last left it: what an edit replaces,
  // and where files attached go.
  const selection = useRef<readonly [number, number] | null>(null);
  const remember = (element: HTMLElement) => {
    selection.current = fieldSelection(element) ?? selection.current;
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
  // Follows an edit of the field, with the mentions and files that still stand after it.
  const follow = (change: FieldChange) => {
    setNotTaken(false);
    const edit: FieldInput = {
      before: value,
      after: change.text,
      inputType: change.inputType,
      data: change.data,
      selection: selection.current,
      now: change.selection,
    };
    const reordered =
      change.order.length !== files.length ||
      change.order.some((key, index) => files[index]?.key !== key);
    onValueChange(
      change.text,
      followFieldInput(edit, mentions, dragged.current),
      reordered ? change.order : undefined,
    );
    selection.current = change.selection;
    mention.follow(change.text, change.selection);
  };
  // Where the caret goes once files attached at it are in the text: after them.
  const caretAfter = useRef<{ readonly marks: number; readonly at: number } | null>(null);
  useLayoutEffect(() => {
    const pending = caretAfter.current;
    const field = fieldRef.current;
    if (pending === null || field === null || markCount(value) !== pending.marks) return;
    caretAfter.current = null;
    if (field.ownerDocument.activeElement !== field) return;
    selectInField(field, pending.at);
    selection.current = [pending.at, pending.at];
  }, [fieldRef, value]);
  const attach = (list: FileList | null, at?: number) => {
    if (!onAttachFiles || list === null || list.length === 0) return;
    setNotTaken(frozen);
    if (frozen) return;
    const place = at ?? selection.current?.[0];
    if (place !== undefined) {
      caretAfter.current = { marks: markCount(value) + list.length, at: place + list.length };
    }
    onAttachFiles([...list], place);
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
          {
            key: file.key,
            text: t("composer.file.failed", {
              name: file.name,
              reason: fileProblemText(file.problem, i18n),
            }),
          },
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
        // Files dropped on the field go where they were dropped; the field took them.
        if (event.defaultPrevented) return;
        if (!onAttachFiles || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        attach(event.dataTransfer.files);
      }}
    >
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
        {failures.map((failure) => failure.text).join(" ")}
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
      <div
        ref={boxRef}
        className="flex items-end gap-1 rounded-composer border border-input bg-surface p-1 shadow-raised transition-[border-color,box-shadow] duration-(--duration-state) focus-within:border-(--tint) focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--tint)_22%,transparent)]"
      >
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
        <ChipField
          ref={fieldRef}
          value={value}
          chips={files.map((file) => ({
            key: file.key,
            content: (
              <DraftFileChip
                file={file}
                arriving={!restored.has(file.key)}
                onRemove={onDetachFile ? () => detach(file.key) : undefined}
                onOpen={onOpenFile}
                unavailable={frozen}
              />
            ),
          }))}
          readOnly={frozen}
          onChange={follow}
          onSelect={(event) => {
            const field = event.currentTarget;
            remember(field);
            const at = fieldSelection(field);
            if (at !== null) mention.follow(fieldText(field), at);
          }}
          onFocus={(event) => {
            const field = event.currentTarget;
            remember(field);
            const at = fieldSelection(field);
            if (at !== null) mention.follow(fieldText(field), at);
          }}
          onBlur={mention.leave}
          onCut={(event) => remember(event.currentTarget)}
          onDragStart={(event) => {
            dragged.current = draggedText(
              value,
              fieldSelection(event.currentTarget) ?? [0, 0],
              mentions,
            );
          }}
          onDragEnd={() => {
            dragged.current = null;
          }}
          onDrop={(event) => {
            const field = event.currentTarget;
            remember(field);
            if (!onAttachFiles || event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            const at = dropOffset(field, event.clientX, event.clientY);
            attach(event.dataTransfer.files, at ?? undefined);
          }}
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
          {...mention.fieldProps}
          data-composer=""
          className="max-h-(--layout-composer-max-height) min-h-8 flex-1 overflow-y-auto overscroll-contain px-1 py-1.5 text-base pointer-coarse:min-h-(--layout-touch-target) pointer-coarse:py-2.5 pointer-coarse:text-lg"
        />
        {empty && onDictate && !sending ? (
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
            variant="ghost"
            size="icon-pill"
            data-send={sendState}
            className={sendButton}
            aria-disabled={!ready}
            aria-label={t("composer.send")}
            aria-describedby={uploading ? waitingId : undefined}
          >
            {/* Keyed by its state, so the arrow pops in when the message can go and flies off with it. */}
            <ArrowUpIcon
              key={sendState}
              className={
                sendState === "ready" ? "pop-in" : sendState === "sending" ? "send-off" : ""
              }
            />
          </Button>
        )}
      </div>
      <span id={waitingId} hidden>
        {t("composer.stillUploading")}
      </span>
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
      {/* Each file that cannot go, which its chip marks, says why. Announced once, above. */}
      {failures.length > 0 && (
        <ul aria-hidden className="flex flex-col px-3 text-xs text-blocked">
          {failures.map((failure) => (
            <li key={failure.key}>{failure.text}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

/**
 * A file in the draft, where it stands in the text: its image or its kind,
 * its name, how its upload goes or that it cannot go, and a way out. Once
 * uploaded, a click opens it.
 */
function DraftFileChip({
  file,
  arriving,
  onRemove,
  onOpen,
  unavailable,
}: {
  file: DraftFile;
  /** Attached since the draft was shown: it settles in. */
  arriving: boolean;
  onRemove: (() => void) | undefined;
  onOpen: ((attachment: Attachment) => void) | undefined;
  /** The draft takes no change: the file cannot be removed meanwhile. */
  unavailable: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const name = draftFileName(file);
  const detail = draftFileDetail(file, i18n, { progress: true });
  const ready = file._tag === "ready" ? file.attachment : null;
  const image = useAttachmentImage(ready);
  const mediaType = file._tag === "ready" ? file.attachment.mediaType : file.mediaType;
  return (
    <span
      title={detail}
      className={cn(
        "relative mx-0.5 inline-flex h-6 max-w-56 items-center gap-1 overflow-hidden rounded-md border align-middle text-xs leading-none select-none",
        arriving && "arrive",
        file._tag === "failed"
          ? "border-blocked/40 bg-blocked-surface text-blocked"
          : "border-border bg-muted text-foreground",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        disabled={ready === null || onOpen === undefined}
        // The field keeps the focus and its caret.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (ready !== null) onOpen?.(ready);
        }}
        aria-label={t("file.open", { name })}
        className="flex h-full min-w-0 items-center gap-1 ps-0.5 pe-1 enabled:cursor-pointer"
      >
        {image?._tag === "shown" ? (
          <img src={image.url} alt="" className="size-5 shrink-0 rounded-sm object-cover" />
        ) : (
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            <FileKindIcon mediaType={mediaType} />
          </span>
        )}
        <span className="truncate font-medium">{name}</span>
        <span className="sr-only">{detail}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          tabIndex={-1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!unavailable) onRemove();
          }}
          aria-disabled={unavailable}
          aria-label={t("composer.file.remove", { name })}
          className="flex h-full shrink-0 items-center pe-1 text-muted-foreground hover:text-foreground aria-disabled:opacity-50"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      )}
      {file._tag === "uploading" && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-(--tint) transition-transform duration-(--duration-fast)"
          style={{ transform: `scaleX(${file.size === 0 ? 0 : file.sent / file.size})` }}
        />
      )}
    </span>
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
  field: RefObject<HTMLDivElement | null>;
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
    if (at === null || element === null || fieldText(element) !== value) return;
    placeCaret.current = null;
    selectInField(element, at);
    setCaret(at);
  }, [field, value]);

  const pick = (option: MentionOption) => {
    if (query === null || caret === null) return;
    const next = insertMention(value, caret, mentions, query, option);
    const element = field.current;
    // A pick that leaves the text as it was changes nothing in the field: the caret moves now.
    if (next.text === value && element !== null) {
      selectInField(element, next.caret);
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
    follow: (text: string, [start, end]: readonly [number, number]) => {
      setCaret(start === end ? start : null);
      if (dismissed !== null && mentionQuery(text, start, mentions)?.start !== dismissed) {
        setDismissed(null);
      }
    },
    leave: () => setCaret(null),
    /** Handles the key when the list is open; true when it took it. */
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
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

/** The members and `@everyone` the operator can mention, above the composer. */
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
      className="absolute start-0 bottom-0 z-10 flex max-h-60 w-full max-w-72 flex-col overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-1 shadow-overlay"
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
                {avatar && (
                  <BotAvatar avatar={avatar} seed={option.id} state="idle" size={20} still />
                )}
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
