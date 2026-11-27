// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Entry,
  MAX_QUOTE_PASSAGE_LENGTH,
  MAX_QUOTES,
  type MessageEntry,
  type MessageQuote,
  quoteOpening,
  type QuoteRequest,
} from "@j3-bots/contracts";

/**
 * Quotes (decision 0094): a reply quotes a whole message, a quote a passage
 * of its text. A message carries at most `MAX_QUOTES`, a reply among them at
 * most once, and first.
 */

/** A message that can be quoted: the operator's or a bot's, which the server has. */
export type QuotableMessage = MessageEntry & {
  readonly author: Exclude<MessageEntry["author"], { readonly _tag: "system" }>;
};

/** Whether `entry` can be quoted: a message the operator or a bot wrote. J3 Bots' own are notices. */
export const isQuotable = (entry: Entry): entry is QuotableMessage =>
  entry._tag === "message" && entry.author._tag !== "system";

/** A reply to `message`: the message quoted whole. */
export const replyTo = (message: QuotableMessage): MessageQuote => ({
  entryId: message.id,
  author: message.author,
  saidAt: message.createdAt,
  quoted: quoteOpening(message.text),
});

/**
 * What a selection of `message`'s text, from `start` to `end`, quotes: the
 * passage, trimmed; `too-long` past `MAX_QUOTE_PASSAGE_LENGTH`; `null` when it
 * holds only spaces.
 */
export const passageOf = (
  message: QuotableMessage,
  start: number,
  end: number,
): MessageQuote | "too-long" | null => {
  const text = message.text.slice(Math.max(0, start), Math.max(start, end)).trim();
  if (text === "") return null;
  if (text.length > MAX_QUOTE_PASSAGE_LENGTH) return "too-long";
  return {
    entryId: message.id,
    author: message.author,
    saidAt: message.createdAt,
    quoted: { _tag: "passage", text },
  };
};

/** What `message.send` names of a quote. */
export const quoteRequestOf = (quote: MessageQuote): QuoteRequest =>
  quote.quoted._tag === "passage"
    ? { entryId: quote.entryId, passage: quote.quoted.text }
    : { entryId: quote.entryId };

const passageKey = (quote: MessageQuote) =>
  quote.quoted._tag === "passage" ? quote.quoted.text : null;

/** Whether two quotes quote the same: the same message, whole or by the same passage. */
const sameQuote = (one: MessageQuote, other: MessageQuote) =>
  one.entryId === other.entryId && passageKey(one) === passageKey(other);

export const sameQuotes = (one: ReadonlyArray<MessageQuote>, other: ReadonlyArray<MessageQuote>) =>
  one.length === other.length &&
  one.every((quote, index) => {
    const twin = other[index];
    return twin !== undefined && sameQuote(quote, twin);
  });

/**
 * A draft's quotes with `quote` added: a reply replaces the draft's reply,
 * first; a passage goes last. `full` when the draft has `MAX_QUOTES` and
 * `quote` replaces none of them; the same quotes when it has it already.
 */
export const withQuote = (
  quotes: ReadonlyArray<MessageQuote>,
  quote: MessageQuote,
): ReadonlyArray<MessageQuote> | "full" => {
  if (quote.quoted._tag === "message") {
    const others = quotes.filter((one) => one.quoted._tag !== "message");
    if (others.length >= MAX_QUOTES) return "full";
    return [quote, ...others];
  }
  if (quotes.some((one) => sameQuote(one, quote))) return quotes;
  if (quotes.length >= MAX_QUOTES) return "full";
  return [...quotes, quote];
};

/** Whether a draft with `quotes` takes one more passage. */
export const takesPassage = (quotes: ReadonlyArray<MessageQuote>) => quotes.length < MAX_QUOTES;

/** The reply among `quotes`, if any. */
export const replyIn = (quotes: ReadonlyArray<MessageQuote>) =>
  quotes.find((quote) => quote.quoted._tag === "message") ?? null;

/** Whether a draft with `quotes` takes a reply: one in place of its own, or one more quote. */
export const takesReply = (quotes: ReadonlyArray<MessageQuote>) =>
  replyIn(quotes) !== null || quotes.length < MAX_QUOTES;

/**
 * What a quote's card reads: the passage, or the start of the message, as
 * one line of words with the marks that set code apart left out, and `…`
 * where the message went on. Empty for a message of files alone.
 */
export const quoteText = (quote: MessageQuote): string => {
  const words = (text: string) =>
    text
      .replace(/```[\w+-]*/g, " ")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  return quote.quoted._tag === "passage"
    ? words(quote.quoted.text)
    : `${words(quote.quoted.opening)}${quote.quoted.more ? "…" : ""}`;
};
