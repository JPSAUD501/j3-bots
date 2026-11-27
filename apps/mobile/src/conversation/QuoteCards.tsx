// SPDX-License-Identifier: AGPL-3.0-or-later
import { quoteText, replyIn } from "@j3-bots/client-runtime/presentation";
import type { Bot, MessageQuote } from "@j3-bots/contracts";
import { Reply, X } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { useQuoting } from "./Quotes.tsx";
import { useColor } from "../theme.ts";
import { useBotInk } from "./tint.ts";

/** What tells a message's quotes apart: a message is quoted whole once, and each passage of it once. */
const quoteKey = (quote: MessageQuote) =>
  quote.quoted._tag === "passage" ? `${quote.entryId}:${quote.quoted.text}` : quote.entryId;

/** The small face beside a quote's author. */
const FACE = 16;

/** Who wrote a quoted message: "You" for the operator, a bot by its name now, a deleted one as such. */
function useAuthor() {
  const { t } = usePresentation().i18n;
  const bots = useBots();
  return (quote: MessageQuote): { readonly name: string; readonly bot: Bot | null } => {
    if (quote.author._tag === "operator") return { name: t("quote.you"), bot: null };
    const bot = bots.get(quote.author.botId) ?? null;
    return { name: bot?.profile.name ?? t("bot.unknown"), bot };
  };
}

/** A quote's author: a bot's still face, or none for the operator, then the name. */
function AuthorLine({
  name,
  bot,
  quoteIsBot,
}: {
  readonly name: string;
  readonly bot: Bot | null;
  readonly quoteIsBot: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      {bot !== null ? (
        <BotAvatar avatar={bot.profile.avatar} seed={bot.id} state="idle" size={FACE} still />
      ) : (
        quoteIsBot && (
          <View className="rounded-pill bg-muted" style={{ width: FACE, height: FACE }} />
        )
      )}
      <Text numberOfLines={1} className="shrink text-xs font-medium text-foreground">
        {name}
      </Text>
    </View>
  );
}

/**
 * The messages a sent message quotes, above its words: each a small card
 * with who wrote it and the passage, or the start of the message, on two
 * lines at most, edged in its author's color. A tap reads the conversation
 * back to the message and shows it; one no longer there, or that could not be
 * read, says so in the card, and the second can be tapped again.
 */
export function QuoteCards({
  quotes,
  side,
  maxWidth,
}: {
  readonly quotes: ReadonlyArray<MessageQuote>;
  readonly side: "start" | "end";
  readonly maxWidth: number;
}) {
  if (quotes.length === 0) return null;
  return (
    <View
      style={{ maxWidth }}
      className={`gap-1 self-stretch ${side === "end" ? "items-end" : "items-start"}`}
    >
      {quotes.map((quote) => (
        <QuoteCard key={quoteKey(quote)} quote={quote} maxWidth={maxWidth} />
      ))}
    </View>
  );
}

function QuoteCard({
  quote,
  maxWidth,
}: {
  readonly quote: MessageQuote;
  readonly maxWidth: number;
}) {
  const { t } = usePresentation().i18n;
  const quoting = useQuoting();
  const author = useAuthor()(quote);
  // Edged in its author's color: a bot's own, the accent for the operator, muted for a bot gone.
  const ink = useBotInk(author.bot?.profile.avatar ?? null);
  const accent = useColor("accent-accent");
  const edge = quote.author._tag === "operator" ? accent : ink;
  const [lost, setLost] = useState<"missing" | "unreachable" | null>(null);
  const [going, setGoing] = useState(false);
  const words = quoteText(quote);
  const shown =
    lost === "missing"
      ? t("quote.missing")
      : lost === "unreachable"
        ? t("quote.unreachable")
        : words === ""
          ? t("quote.files")
          : words;
  const go = () => {
    if (going || lost === "missing") return;
    setGoing(true);
    void quoting.goTo(quote.entryId).then((revealed) => {
      setGoing(false);
      setLost(revealed === "shown" ? null : revealed);
    });
  };
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={
        quote.author._tag === "operator"
          ? t("quote.goToYours")
          : t("quote.goTo", { name: author.name })
      }
      accessibilityValue={{ text: shown }}
      accessibilityState={{ busy: going, disabled: lost === "missing" }}
      onPress={go}
      style={{ maxWidth, borderStartColor: edge }}
      className="gap-0.5 rounded-lg border border-s-4 border-border bg-surface px-2.5 py-1.5 active:bg-muted"
    >
      <AuthorLine name={author.name} bot={author.bot} quoteIsBot={quote.author._tag === "bot"} />
      <Text
        numberOfLines={2}
        className={`text-sm ${lost === null ? "text-muted-foreground" : "text-blocked"}`}
      >
        {shown}
      </Text>
    </PressScale>
  );
}

/**
 * What the draft quotes, over the composer: the reply as a strip that says
 * whom it answers, with the start of the message on one line, then each
 * passage as a compact chip with its author and the passage on two lines.
 * Each has an × that takes it out, unless the draft takes no change.
 */
export function DraftQuotes({
  quotes,
  frozen,
  onRemove,
}: {
  readonly quotes: ReadonlyArray<MessageQuote>;
  readonly frozen: boolean;
  /** Takes the quote at `index` of `quotes` out of the draft. */
  readonly onRemove: (index: number) => void;
}) {
  const { t } = usePresentation().i18n;
  const authorOf = useAuthor();
  if (quotes.length === 0) return null;
  const reply = replyIn(quotes);
  const passages = quotes.flatMap((quote, index) =>
    quote.quoted._tag === "passage" ? [{ quote, index }] : [],
  );
  return (
    <View className="gap-1.5">
      {reply !== null && (
        <View className="flex-row items-center gap-2 rounded-lg border border-border bg-surface ps-3">
          <Icon icon={Reply} size={16} color="accent-muted-foreground" />
          <View className="min-w-0 flex-1 py-1.5">
            <Text numberOfLines={1} className="text-xs font-medium text-foreground">
              {reply.author._tag === "operator"
                ? t("quote.replyingToYou")
                : t("quote.replyingTo", { name: authorOf(reply).name })}
            </Text>
            <Text numberOfLines={1} className="text-sm text-muted-foreground">
              {quoteText(reply) === "" ? t("quote.files") : quoteText(reply)}
            </Text>
          </View>
          <RemoveButton
            label={t("quote.cancelReply")}
            disabled={frozen}
            onPress={() => onRemove(quotes.indexOf(reply))}
          />
        </View>
      )}
      {passages.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // A tap on × takes the quote out without closing the keyboard.
          keyboardShouldPersistTaps="always"
          contentContainerClassName="gap-1.5"
        >
          {passages.map(({ quote, index }) => {
            const author = authorOf(quote);
            return (
              <View
                key={quoteKey(quote)}
                className="w-56 flex-row items-start rounded-lg border border-border bg-surface ps-2.5"
              >
                <View className="min-w-0 flex-1 gap-0.5 py-1.5">
                  <AuthorLine
                    name={author.name}
                    bot={author.bot}
                    quoteIsBot={quote.author._tag === "bot"}
                  />
                  <Text numberOfLines={2} className="text-sm text-muted-foreground">
                    {quoteText(quote)}
                  </Text>
                </View>
                <RemoveButton
                  label={t("quote.remove")}
                  disabled={frozen}
                  onPress={() => onRemove(index)}
                />
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/** The × that takes a quote out of the draft, in a full touch box. */
function RemoveButton({
  label,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <PressScale
      depth="round"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      className="size-11 items-center justify-center rounded-full active:bg-muted"
    >
      <Icon icon={X} size={16} color="accent-muted-foreground" />
    </PressScale>
  );
}
