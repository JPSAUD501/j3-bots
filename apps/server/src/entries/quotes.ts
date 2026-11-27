// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EntryId,
  type EntryTarget,
  Invalid,
  type MessageEntry,
  type MessageQuote,
  quoteOpening,
  type QuoteRequest,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Entries } from "./Entries.ts";
import { sameTarget } from "./sameTarget.ts";

/**
 * A message as a quote keeps it: whole, or the passage of its text given,
 * which must be there word for word, with the operator's comment on it.
 * `null` for anything a message cannot quote: J3 Bots' own message, a
 * passage not in the text, one that is not trimmed, or a comment on a whole
 * message, whose reply is the message itself.
 */
export const quoteOf = (
  message: MessageEntry,
  passage: string | null,
  comment: string | null = null,
): MessageQuote | null => {
  const { author } = message;
  if (author._tag === "system") return null;
  if (passage === null) {
    if (comment !== null) return null;
    return {
      entryId: message.id,
      author,
      saidAt: message.createdAt,
      quoted: quoteOpening(message.text),
    };
  }
  if (passage.trim() !== passage || !message.text.includes(passage)) return null;
  return {
    entryId: message.id,
    author,
    saidAt: message.createdAt,
    quoted: { _tag: "passage", text: passage },
    ...(comment === null ? {} : { comment }),
  };
};

/**
 * The message `entryId` names, when it is a message of `target`; none
 * otherwise, so a quote across conversations or rooms finds nothing.
 */
export const messageIn = Effect.fn("quotes.messageIn")(function* (
  entries: Entries["Service"],
  target: EntryTarget,
  entryId: EntryId,
) {
  const found = yield* entries.find(entryId);
  return Option.flatMap(found, ({ target: where, entry }) =>
    entry._tag === "message" && sameTarget(where, target) ? Option.some(entry) : Option.none(),
  );
});

/**
 * The operator's quotes, as the message keeps them (decision 0094): each a
 * message of `target`, quoted whole at most once among them (a reply), each
 * passage word for word in its message's text, a comment only on a passage
 * (decision 0106), and none twice. Anything else refuses them all with
 * `Invalid("quotes")`.
 */
export const resolveQuotes = Effect.fn("quotes.resolve")(function* (
  entries: Entries["Service"],
  target: EntryTarget,
  requests: ReadonlyArray<QuoteRequest>,
) {
  const keys = requests.map((request) => `${request.entryId}\u0000${request.passage ?? ""}`);
  if (
    new Set(keys).size !== keys.length ||
    requests.filter((request) => request.passage === undefined).length > 1
  ) {
    return yield* new Invalid({ reason: "quotes" });
  }
  const quotes: Array<MessageQuote> = [];
  for (const request of requests) {
    const message = yield* messageIn(entries, target, request.entryId);
    const quote = Option.isSome(message)
      ? quoteOf(message.value, request.passage ?? null, request.comment ?? null)
      : null;
    if (quote === null) return yield* new Invalid({ reason: "quotes" });
    quotes.push(quote);
  }
  return quotes;
});
