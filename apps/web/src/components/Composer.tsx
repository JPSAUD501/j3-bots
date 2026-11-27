// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment, Avatar, MessageQuote, SuggestedReply } from "@j3-bots/contracts";
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
  namedMentions,
  standingMentions,
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
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { play } from "../lib/motion";
import { type FieldInput, followFieldInput } from "../lib/fieldEdit";
import { useAttachmentImage } from "./attachmentImages";
import { BotAvatar, RoomAvatar, type RoomAvatarMember } from "./avatar/BotAvatar";
import {
  ChipField,
  dropOffset,
  type FieldChange,
  type FieldRun,
  fieldSelection,
  fieldText,
  selectInField,
} from "./ChipField";
import { FileKindIcon } from "./FileCard";
import { MentionChip, RoomMentionChip } from "./MentionChip";
import { type PromptMenu, PromptForm, PromptList, usePromptPicker } from "./PromptPicker";
import { DraftQuotes } from "./Quotes";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

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

/** What the composer offers after `@`: a bot, drawn by its face, or a room, by its mark. */
export type MentionCandidate =
  | (Extract<Mentionable, { readonly _tag: "bot" }> & { readonly avatar: Avatar })
  | (Extract<Mentionable, { readonly _tag: "room" }> & {
      readonly members: ReadonlyArray<RoomAvatarMember>;
    });

/**
 * What `@` offers in a draft: in a room, its members and `@everyone`; in a
 * bot's conversation, the operator's other bots and the rooms that bot is in.
 */
export interface MentionChoices {
  readonly candidates: ReadonlyArray<MentionCandidate>;
  /** Whether `@everyone` is offered, as it is in a room. */
  readonly everyone: boolean;
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
  /** The messages the draft quotes: its reply first, when it has one, then passages. */
  readonly quotes?: ReadonlyArray<MessageQuote>;
  /** Takes the quote at `index` out of the draft. */
  readonly onUnquote?: (index: number) => void;
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
   * What typing `@` offers (`MentionChoices`). Only a pick mentions one; a
   * name typed or pasted mentions nothing.
   */
  readonly mentionable?: MentionChoices;
  /**
   * In a bot's conversation, the prompts its connectors offer: a draft that is
   * `/` and a word offers those that match it, and what a prompt's server
   * writes replaces the draft.
   */
  readonly prompts?: PromptMenu;
  /**
   * In a bot's conversation, the reply the AI guessed the operator may send
   * next, with the message it follows, or null. It is never sent by itself:
   * see the composer.
   */
  readonly suggestion?: SuggestedReply | null;
}

/**
 * Puts the focus in a composer's field, `field`, with the caret after its
 * text, as after Reply or Quote, which add to the draft from elsewhere.
 */
export function focusAtEnd(field: HTMLElement | null) {
  if (field === null) return;
  field.focus();
  selectInField(field, fieldText(field).length);
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
 * quiet line under the composer says who the message wakes. In a bot's
 * conversation, `/` opens the prompts its connectors offer the same way; a
 * prompt with arguments asks for them above the composer, and what its server
 * writes becomes the draft, which the operator reads and sends as their own.
 * A reply the AI suggests shows in place of the placeholder while the draft
 * is empty and no list is open, with Use beside it: Use, or Tab, puts it in
 * the draft with the caret after it, to send or change; Escape sets it aside
 * until a later answer brings another.
 * It leaves as soon as the operator types. What the draft quotes shows above
 * the field: its reply as a strip, each passage as a chip, each with a way
 * out, after which the focus returns to the field.
 */
export function Composer({
  draftKey,
  recipient,
  value,
  mentions = [],
  onValueChange,
  files = [],
  quotes = [],
  onUnquote,
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
  prompts,
  suggestion = null,
}: ComposerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const pickerRef = useRef<HTMLInputElement>(null);
  const ownFieldRef = useRef<HTMLDivElement>(null);
  const fieldRef = inputRef ?? ownFieldRef;
  const waitingId = useId();
  const suggestionId = useId();
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
    choices: frozen ? undefined : mentionable,
  });
  const prompt = usePromptPicker({
    draftKey,
    value,
    onValueChange: (text) => onValueChange(text, []),
    field: fieldRef,
    menu: frozen ? undefined : prompts,
  });
  // The message whose suggestion the operator set aside: a later answer's is offered again.
  const [setAside, setSetAside] = useState<SuggestedReply["after"] | null>(null);
  const offered =
    suggestion !== null &&
    value === "" &&
    files.length === 0 &&
    !frozen &&
    !mention.open &&
    !prompt.open &&
    prompt.chosen === null &&
    setAside !== suggestion.after
      ? suggestion.text
      : null;
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
    prompt.edited();
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
  // The suggestion becomes the draft, with the caret after it, to send or change.
  const takeSuggestion = (text: string) => {
    focusField();
    caretAfter.current = { marks: 0, at: text.length };
    onValueChange(text, []);
  };
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
            candidates={mentionable?.candidates ?? []}
            label={
              mentionable?.everyone === false ? t("mention.labelConversation") : t("mention.label")
            }
            active={mention.active}
            optionId={mention.optionId}
            onPick={mention.pick}
          />
        </div>
      )}
      {prompt.open && (
        <div className="relative">
          <PromptList
            id={prompt.listId}
            options={prompt.options}
            active={prompt.active}
            optionId={prompt.optionId}
            onPick={prompt.pick}
          />
        </div>
      )}
      {prompt.chosen !== null && (
        <PromptForm
          chosen={prompt.chosen}
          onFill={prompt.fill}
          onUse={prompt.use}
          onCancel={prompt.cancel}
        />
      )}
      {onUnquote !== undefined && (
        <DraftQuotes
          quotes={quotes}
          unavailable={frozen}
          onRemove={(index) => {
            onUnquote(index);
            focusField();
          }}
        />
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
          runs={mentionRuns(value, mentions, mentionable)}
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
            prompt.follow();
          }}
          onBlur={() => {
            mention.leave();
            prompt.leave();
          }}
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
            if (mention.onKeyDown(event) || prompt.onKeyDown(event)) return;
            const plainKey = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            if (offered !== null && plainKey && !event.nativeEvent.isComposing) {
              if (event.key === "Tab") {
                event.preventDefault();
                takeSuggestion(offered);
                return;
              }
              if (event.key === "Escape") {
                // Taken here, so the shell does not close the details as well.
                event.preventDefault();
                setSetAside(suggestion?.after ?? null);
                return;
              }
            }
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
          placeholder={offered ?? label}
          aria-label={label}
          aria-describedby={offered === null ? undefined : suggestionId}
          {...mention.fieldProps}
          {...prompt.fieldProps}
          data-composer=""
          className="max-h-(--layout-composer-max-height) min-h-8 flex-1 overflow-y-auto overscroll-contain px-1 py-1.5 text-base pointer-coarse:min-h-(--layout-touch-target) pointer-coarse:py-2.5 pointer-coarse:text-lg"
        />
        {offered !== null && (
          <Button
            variant="ghost-muted"
            size="sm"
            // The field keeps the focus, so the keyboard stays up on a touch screen.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => takeSuggestion(offered)}
            aria-label={t("composer.suggestion.useLabel")}
            className="appear shrink-0 gap-1.5 rounded-full pointer-coarse:h-(--layout-touch-target)"
          >
            {t("composer.suggestion.use")}
            <Kbd aria-hidden className="hidden pointer-fine:inline-flex">
              Tab
            </Kbd>
          </Button>
        )}
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
      <span id={suggestionId} hidden>
        {offered !== null && t("composer.suggestion", { text: offered })}
      </span>
      {prompt.cut && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {t("prompt.cut")}
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
  choices,
}: {
  draftKey: string;
  value: string;
  mentions: ReadonlyArray<DraftMention>;
  onValueChange: (value: string, mentions: ReadonlyArray<DraftMention>) => void;
  field: RefObject<HTMLDivElement | null>;
  choices: MentionChoices | undefined;
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
    choices === undefined || caret === null ? null : mentionQuery(value, caret, mentions);
  const options =
    query === null || choices === undefined
      ? []
      : mentionOptions(query.query, choices.candidates, choices.everyone);
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
      choices === undefined
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

/**
 * Each pick that counts as the draft stands, drawn as its chip in the field,
 * so what the field shows is what goes: in a room, each member it addresses;
 * in a bot's conversation, each bot and room it mentions (`namedMentions`).
 * `@everyone`, and what is no longer offered, stay text.
 */
function mentionRuns(
  value: string,
  mentions: ReadonlyArray<DraftMention>,
  choices: MentionChoices | undefined,
): ReadonlyArray<FieldRun> {
  if (choices === undefined) return [];
  const { candidates } = choices;
  const counted = choices.everyone
    ? standingMentions(value, mentions)
    : namedMentions(value, mentions, candidates);
  return counted.flatMap((mention): ReadonlyArray<FieldRun> => {
    if (mention._tag === "everyone") return [];
    const at = mention.position;
    const text = `@${mention.label}`;
    if (mention._tag === "bot") {
      const bot = candidates.find(
        (candidate) => candidate._tag === "bot" && candidate.id === mention.botId,
      );
      if (bot?._tag !== "bot") return [];
      return [
        {
          at,
          text,
          content: <MentionChip avatar={bot.avatar} seed={bot.id} name={mention.label} />,
        },
      ];
    }
    const room = candidates.find(
      (candidate) => candidate._tag === "room" && candidate.id === mention.roomId,
    );
    if (room?._tag !== "room") return [];
    return [{ at, text, content: <RoomMentionChip members={room.members} name={mention.label} /> }];
  });
}

/** What the operator can mention, above the composer: bots, rooms or `@everyone`. */
export function MentionList({
  id,
  options,
  candidates,
  label,
  active,
  optionId,
  onPick,
}: {
  id: string;
  options: ReadonlyArray<MentionOption>;
  candidates: ReadonlyArray<MentionCandidate>;
  /** What the list is for, as a screen reader names it. */
  label: string;
  active: number;
  optionId: (index: number) => string;
  onPick: (option: MentionOption) => void;
}) {
  const { t } = useI18n();
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
      aria-label={label}
      className="absolute start-0 bottom-0 z-10 flex max-h-60 w-full max-w-72 flex-col overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-1 shadow-overlay"
    >
      {options.map((option, index) => {
        const candidate =
          option._tag === "everyone"
            ? undefined
            : candidates.find((one) => one._tag === option._tag && one.id === option.id);
        const avatar = candidate?._tag === "bot" ? candidate.avatar : undefined;
        return (
          <li
            key={option._tag === "everyone" ? EVERYONE : `${option._tag}:${option.id}`}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            // The field keeps the focus, so the keyboard stays up on a touch screen.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onPick(option)}
            // A bot's option, active, takes a tint of its color, as its mention does.
            className={cn(
              "flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm pointer-coarse:min-h-(--layout-touch-target)",
              avatar === undefined
                ? "aria-selected:bg-muted"
                : [tintOf(avatar), "aria-selected:bg-(--tint-bubble)"],
            )}
          >
            {option._tag === "everyone" ? (
              <>
                <UsersIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span>@{EVERYONE}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {t("mention.everyone")}
                </span>
              </>
            ) : (
              <>
                {candidate?._tag === "bot" && (
                  <BotAvatar
                    avatar={candidate.avatar}
                    seed={candidate.id}
                    state="idle"
                    size={20}
                    still
                  />
                )}
                {candidate?._tag === "room" && <RoomAvatar members={candidate.members} size={20} />}
                <span className="min-w-0 truncate">{option.name}</span>
                {option._tag === "room" && (
                  <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                    {t("mention.room")}
                  </span>
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
