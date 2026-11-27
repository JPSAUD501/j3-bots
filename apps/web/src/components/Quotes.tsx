// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import type { Revealed } from "@j3-bots/client-runtime";
import { quoteText } from "@j3-bots/client-runtime/presentation";
import { type EntryId, MAX_QUOTE_COMMENT_LENGTH, type MessageQuote } from "@j3-bots/contracts";
import { PencilIcon, QuoteIcon, ReplyIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, use, useState } from "react";
import { useBots, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { FaceOf } from "./avatar/TeamAvatars";
import { Button } from "./ui/button";
import { textField } from "./ui/field";

/** Reads back to a quoted message, which then shows: whether it could. */
export type GoToQuote = (entryId: EntryId) => Promise<Revealed>;

/**
 * Goes to the message a quote's block names (`Timeline` provides it). Where
 * it is null, as in the gallery's still frames, a block goes nowhere.
 */
export const OpenQuote = createContext<GoToQuote | null>(null);

/** Who wrote a quoted message, as the operator reads it: "You", or the bot's name now. */
function useAuthor(author: MessageQuote["author"]) {
  const { t } = useI18n();
  const bots = useBots();
  if (author._tag === "operator") return { name: t("quote.you"), botId: null };
  const bot = bots.get(author.botId);
  return { name: bot?.profile.name ?? t("bot.unknown"), botId: author.botId };
}

/** What a quote reads: its passage or the start of its message, or that it has files only. */
function useWords(quote: MessageQuote) {
  const { t } = useI18n();
  return quoteText(quote) || t("quote.files");
}

const keyOf = (quote: MessageQuote) =>
  `${quote.entryId}:${quote.quoted._tag === "passage" ? quote.quoted.text : ""}`;

// A quote sits in its bubble as a quiet block of the bubble's own ink, so it reads in the
// operator's dark bubble and in a bot's tinted one alike, in either theme.
const quoteBlock =
  "flex w-full min-w-0 flex-col gap-0.5 rounded-lg bg-[color-mix(in_oklab,currentColor_9%,transparent)] px-2.5 py-1.5 text-start text-sm";

/**
 * What a sent message quotes, at the top of its bubble, before its text:
 * each a quiet block with its author's face and name and the passage, or the
 * start of the message, on at most two lines, and under a passage the
 * operator's comment on it. A block goes to its message, reading back to it
 * when it is not held yet; one no longer there says so in place.
 */
export function SentQuotes({ quotes }: { readonly quotes: ReadonlyArray<MessageQuote> }) {
  return (
    <div className="flex flex-col gap-1.5">
      {quotes.map((quote) => (
        <div key={keyOf(quote)} className="flex flex-col gap-1">
          <SentQuote quote={quote} />
          {quote.comment !== undefined && (
            <p className="break-words whitespace-pre-wrap">{quote.comment}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function SentQuote({ quote }: { readonly quote: MessageQuote }) {
  const { t } = useI18n();
  const goTo = use(OpenQuote);
  const author = useAuthor(quote.author);
  const words = useWords(quote);
  const label =
    quote.author._tag === "operator"
      ? t("quote.goToYours")
      : t("quote.goTo", { name: author.name });
  // How the last try to go to its message ended, or that one is under way.
  const [going, setGoing] = useState<Revealed | "looking" | null>(null);
  const lost = going === "missing" || going === "unreachable";
  const shown =
    going === "missing"
      ? t("quote.missing")
      : going === "unreachable"
        ? t("quote.unreachable")
        : words;
  const content: ReactNode = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
        {author.botId !== null && <FaceOf botId={author.botId} size={16} />}
        <span className="truncate">{author.name}</span>
      </span>
      <span className={cn("line-clamp-2 break-words opacity-75", lost && "italic")}>{shown}</span>
    </>
  );
  if (goTo === null) return <div className={quoteBlock}>{content}</div>;
  const settled = going === "looking" || going === "missing";
  return (
    <button
      type="button"
      aria-label={label}
      aria-description={shown}
      aria-disabled={settled}
      onClick={() => {
        if (settled) return;
        setGoing("looking");
        void goTo(quote.entryId).then(setGoing);
      }}
      className={cn(
        quoteBlock,
        "cursor-pointer transition-colors duration-(--duration-fast) ease-out hover:bg-[color-mix(in_oklab,currentColor_14%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:hover:bg-[color-mix(in_oklab,currentColor_9%,transparent)]",
      )}
    >
      {content}
    </button>
  );
}

const chipButton = cn(
  "pressable pressable-round inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:opacity-50 data-popup-open:bg-muted-strong data-popup-open:text-foreground",
  touchTarget,
);

/**
 * What the draft quotes, inside the composer above its text: each a compact
 * chip, a reply's arrow or a passage's quote mark, its author's face (or
 * "You"), and the start of what it quotes on one line, with a way out. A
 * passage's pencil writes the operator's comment on it, where the server
 * takes one (`onComment`).
 */
export function DraftQuoteChips({
  quotes,
  onRemove,
  onComment,
  unavailable,
}: {
  readonly quotes: ReadonlyArray<MessageQuote>;
  /** Takes the quote at `index` out of the draft. */
  readonly onRemove: (index: number) => void;
  /** Sets the operator's comment on the passage at `index`; empty takes it off. */
  readonly onComment: ((index: number, comment: string) => void) | undefined;
  /** The draft takes no change: no quote can be taken out or commented meanwhile. */
  readonly unavailable: boolean;
}) {
  const { t } = useI18n();
  if (quotes.length === 0) return null;
  return (
    <ul aria-label={t("quote.drafted")} className="flex min-w-0 flex-wrap gap-1 px-1 pt-1">
      {quotes.map((quote, index) => (
        <QuoteChip
          key={keyOf(quote)}
          quote={quote}
          unavailable={unavailable}
          onRemove={() => {
            if (!unavailable) onRemove(index);
          }}
          onComment={
            onComment === undefined || quote.quoted._tag !== "passage"
              ? undefined
              : (comment) => onComment(index, comment)
          }
        />
      ))}
    </ul>
  );
}

function QuoteChip({
  quote,
  onRemove,
  onComment,
  unavailable,
}: {
  readonly quote: MessageQuote;
  readonly onRemove: () => void;
  readonly onComment: ((comment: string) => void) | undefined;
  readonly unavailable: boolean;
}) {
  const { t } = useI18n();
  const author = useAuthor(quote.author);
  const words = useWords(quote);
  const reply = quote.quoted._tag === "message";
  const what = reply
    ? quote.author._tag === "operator"
      ? t("quote.replyingToYou")
      : t("quote.replyingTo", { name: author.name })
    : t("quote.quoting", { name: author.name });
  const Glyph = reply ? ReplyIcon : QuoteIcon;
  return (
    <li
      title={quote.comment === undefined ? words : `${words}\n\n${quote.comment}`}
      className="appear flex h-7 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted ps-1.5 pe-0.5 text-xs text-foreground"
    >
      <Glyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {author.botId === null ? (
        <span aria-hidden className="shrink-0 font-medium">
          {author.name}
        </span>
      ) : (
        <FaceOf botId={author.botId} size={16} />
      )}
      <span className="sr-only">{what}:</span>
      <span className="max-w-[16em] min-w-0 truncate">{words}</span>
      {onComment !== undefined && (
        <CommentButton
          comment={quote.comment}
          words={words}
          unavailable={unavailable}
          onComment={onComment}
        />
      )}
      <button
        type="button"
        aria-label={reply ? t("quote.cancelReply") : t("quote.remove")}
        aria-disabled={unavailable}
        onClick={onRemove}
        className={chipButton}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}

/** A passage chip's pencil: the operator's comment on it, written in a small card over the chip. */
function CommentButton({
  comment,
  words,
  unavailable,
  onComment,
}: {
  readonly comment: string | undefined;
  readonly words: string;
  readonly unavailable: boolean;
  readonly onComment: (comment: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next || !unavailable) setOpen(next);
      }}
    >
      <Popover.Trigger
        aria-label={comment === undefined ? t("quote.comment.add") : t("quote.comment.edit")}
        aria-disabled={unavailable}
        className={cn(chipButton, comment !== undefined && "text-foreground")}
      >
        <PencilIcon aria-hidden className="size-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Popover.Popup
            aria-label={t("quote.comment.label")}
            className="origin-(--transform-origin) rounded-lg border border-border bg-surface text-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out"
          >
            <QuoteCommentEditor
              passage={words}
              initial={comment ?? ""}
              saveLabel={t("quote.comment.save")}
              onCancel={() => setOpen(false)}
              onSave={(text) => {
                onComment(text);
                setOpen(false);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The operator's comment on a passage they quote, as T3 Code's citations
 * take one: an optional few words, Enter saves them and Shift+Enter starts a
 * new line, Escape leaves as it was. `passage`, when given, says above it
 * what the comment is on.
 */
export function QuoteCommentEditor({
  initial,
  saveLabel,
  onSave,
  onCancel,
  passage,
}: {
  readonly initial: string;
  readonly saveLabel: string;
  /** The words as written; empty takes a comment off. */
  readonly onSave: (comment: string) => void;
  readonly onCancel: () => void;
  readonly passage?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(initial);
  return (
    // Not a form: it shows over the composer's, which a submit here would reach and send.
    <div className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 p-2">
      {passage !== undefined && (
        <p className="line-clamp-2 px-1 text-xs text-muted-foreground">“{passage}”</p>
      )}
      <textarea
        // It shows because the operator asked to comment: it takes the focus.
        autoFocus
        rows={3}
        value={text}
        maxLength={MAX_QUOTE_COMMENT_LENGTH}
        placeholder={t("quote.comment.placeholder")}
        aria-label={t("quote.comment.label")}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Kept here: the composer and the timeline behind it take these keys too.
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSave(text);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className={cn(textField, "max-h-40 resize-none py-2")}
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("quote.comment.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => onSave(text)}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Reply, beside React on a message: it shows while the pointer is over the
 * message or it has focus. Where the draft quotes all a message can, it says
 * so instead.
 */
export function ReplyButton({
  onReply,
  full,
}: {
  readonly onReply: () => void;
  readonly full: boolean;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-label={t("quote.reply")}
      aria-disabled={full}
      {...(full ? { "aria-description": t("quote.full"), title: t("quote.full") } : {})}
      onClick={() => {
        if (!full) onReply();
      }}
      className={cn(
        "pressable pressable-round inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground opacity-0 transition-[opacity,color,background-color] duration-(--duration-fast) ease-out group-hover/message:opacity-100 group-focus-within/message:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground",
        touchTarget,
      )}
    >
      <ReplyIcon aria-hidden className="size-4" />
    </button>
  );
}

/**
 * Lights the message `row` holds (its `data-quote-target`) as the source of a
 * quote the operator went to: a ring that shows and fades, without moving
 * (`data-quote-source` in `index.css`). Lit again, it starts over.
 */
export function lightSource(row: Element) {
  const source = row.querySelector<HTMLElement>("[data-quote-target]");
  if (source === null) return;
  source.removeAttribute("data-quote-source");
  // Read once, so a light still on starts over.
  void source.offsetWidth;
  source.setAttribute("data-quote-source", "lit");
  const off = (event: AnimationEvent) => {
    if (event.target !== source || event.animationName !== "quote-source-out") return;
    source.removeAttribute("data-quote-source");
    source.removeEventListener("animationend", off);
  };
  source.addEventListener("animationend", off);
}
