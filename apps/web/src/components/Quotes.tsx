// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Revealed } from "@j3-bots/client-runtime";
import { quoteText } from "@j3-bots/client-runtime/presentation";
import type { EntryId, MessageQuote } from "@j3-bots/contracts";
import { ReplyIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, use, useState } from "react";
import { useBots, useI18n } from "../app/context";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { FaceOf } from "./avatar/TeamAvatars";

/** Reads back to a quoted message, which then shows: whether it could. */
export type GoToQuote = (entryId: EntryId) => Promise<Revealed>;

/**
 * Goes to the message a quote's card names (`Timeline` provides it). Where it
 * is null, as in the gallery's still frames, a card goes nowhere.
 */
export const OpenQuote = createContext<GoToQuote | null>(null);

/** Who wrote a quoted message, as the operator reads it: "You", or the bot's name now. */
function useAuthor(author: MessageQuote["author"]) {
  const { t } = useI18n();
  const bots = useBots();
  if (author._tag === "operator") return { name: t("quote.you"), avatar: null, botId: null };
  const bot = bots.get(author.botId);
  return {
    name: bot?.profile.name ?? t("bot.unknown"),
    avatar: bot?.profile.avatar ?? null,
    botId: author.botId,
  };
}

/** What a quote's card reads: its passage or the start of its message, or that it has files only. */
function useWords(quote: MessageQuote) {
  const { t } = useI18n();
  return quoteText(quote) || t("quote.files");
}

// A quote is set apart by a bar in its author's color, on a quiet fill.
const quoteCard = "border-s-2 border-(--tint) bg-muted/70";

/**
 * The messages a sent message quotes, above it: each a small card with its
 * author's face and name and the passage, or the start of the message, on
 * at most two lines. A card goes to its message, reading back to it when it
 * is not held yet; one no longer there says so in place.
 */
export function SentQuotes({
  quotes,
  fromOperator,
}: {
  readonly quotes: ReadonlyArray<MessageQuote>;
  /** On the operator's side the cards line up at the end, over their bubble. */
  readonly fromOperator: boolean;
}) {
  return (
    <div
      className={cn("flex max-w-full flex-col gap-1", fromOperator ? "items-end" : "items-start")}
    >
      {quotes.map((quote) => (
        <SentQuote
          key={`${quote.entryId}:${quote.quoted._tag === "passage" ? quote.quoted.text : ""}`}
          quote={quote}
        />
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
  const card = cn(
    tintOf(author.avatar),
    quoteCard,
    "flex max-w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-start text-xs",
    author.avatar === null && "border-muted-foreground/50",
  );
  const content: ReactNode = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 font-semibold">
        {author.botId !== null && <FaceOf botId={author.botId} size={16} />}
        <span className="truncate">{author.name}</span>
      </span>
      <span
        className={cn(
          "line-clamp-2 break-words text-foreground/80",
          lost && "text-muted-foreground italic",
        )}
      >
        {shown}
      </span>
    </>
  );
  if (goTo === null) return <div className={card}>{content}</div>;
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
        card,
        "cursor-pointer transition-colors duration-(--duration-fast) ease-out hover:bg-muted-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:hover:bg-muted/70",
      )}
    >
      {content}
    </button>
  );
}

const removeButton = cn(
  "pressable pressable-round inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:opacity-50",
  touchTarget,
);

/**
 * What the draft quotes, over the composer: its reply as a strip, "Replying
 * to" its author with the start of the message on one line; then each
 * passage as a small chip, its author and the passage on at most two lines.
 * Each has a way out.
 */
export function DraftQuotes({
  quotes,
  onRemove,
  unavailable,
}: {
  readonly quotes: ReadonlyArray<MessageQuote>;
  /** Takes the quote at `index` out of the draft. */
  readonly onRemove: (index: number) => void;
  /** The draft takes no change: no quote can be taken out meanwhile. */
  readonly unavailable: boolean;
}) {
  if (quotes.length === 0) return null;
  const remove = (index: number) => {
    if (!unavailable) onRemove(index);
  };
  const reply = quotes.findIndex((quote) => quote.quoted._tag === "message");
  const replyQuote = quotes[reply];
  const passages = quotes.flatMap((quote, index) =>
    quote.quoted._tag === "passage" ? [{ quote, index }] : [],
  );
  return (
    <div className="flex flex-col gap-1.5">
      {replyQuote !== undefined && (
        <ReplyStrip quote={replyQuote} onRemove={() => remove(reply)} unavailable={unavailable} />
      )}
      {passages.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {passages.map(({ quote, index }) => (
            <PassageChip
              key={`${quote.entryId}:${quote.quoted._tag === "passage" ? quote.quoted.text : ""}`}
              quote={quote}
              onRemove={() => remove(index)}
              unavailable={unavailable}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReplyStrip({
  quote,
  onRemove,
  unavailable,
}: {
  readonly quote: MessageQuote;
  readonly onRemove: () => void;
  readonly unavailable: boolean;
}) {
  const { t } = useI18n();
  const author = useAuthor(quote.author);
  const words = useWords(quote);
  return (
    <div
      className={cn(
        tintOf(author.avatar),
        quoteCard,
        "appear flex min-w-0 items-center gap-2 rounded-md ps-2.5 pe-1 py-1 text-xs",
        author.avatar === null && "border-muted-foreground/50",
      )}
    >
      <ReplyIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-semibold">
          {quote.author._tag === "operator"
            ? t("quote.replyingToYou")
            : t("quote.replyingTo", { name: author.name })}
        </span>
        <span className="text-muted-foreground"> · {words}</span>
      </p>
      <button
        type="button"
        aria-label={t("quote.cancelReply")}
        aria-disabled={unavailable}
        onClick={onRemove}
        className={removeButton}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

function PassageChip({
  quote,
  onRemove,
  unavailable,
}: {
  readonly quote: MessageQuote;
  readonly onRemove: () => void;
  readonly unavailable: boolean;
}) {
  const { t } = useI18n();
  const author = useAuthor(quote.author);
  const words = useWords(quote);
  return (
    <li
      className={cn(
        tintOf(author.avatar),
        quoteCard,
        "appear flex max-w-[min(18rem,100%)] min-w-0 items-start gap-1 rounded-md ps-2 pe-0.5 py-1 text-xs",
        author.avatar === null && "border-muted-foreground/50",
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold">{author.name}</span>
        <span className="line-clamp-2 break-words text-muted-foreground">{words}</span>
      </span>
      <button
        type="button"
        aria-label={t("quote.remove")}
        aria-disabled={unavailable}
        onClick={onRemove}
        className={removeButton}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </li>
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
