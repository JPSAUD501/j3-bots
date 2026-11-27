// SPDX-License-Identifier: AGPL-3.0-or-later
import { quoteText } from "@j3-bots/client-runtime/presentation";
import { type Bot, MAX_QUOTE_COMMENT_LENGTH, type MessageQuote } from "@j3-bots/contracts";
import { type LucideIcon, Pencil, Quote, Reply, X } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text, TextInput } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";
import { useQuoting } from "./Quotes.tsx";

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
  className,
}: {
  readonly name: string;
  readonly bot: Bot | null;
  readonly quoteIsBot: boolean;
  /** The name's text color. */
  readonly className: string;
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
      <Text numberOfLines={1} className={`shrink text-xs font-medium ${className}`}>
        {name}
      </Text>
    </View>
  );
}

/**
 * What a sent message quotes, at the top of its bubble, before its words:
 * each a quiet block of the bubble's own ink, with who wrote it and the
 * passage, or the start of the message, on two lines at most, and under a
 * passage the operator's comment on it (decision 0106). No colored edge: the
 * block reads in the operator's bubble and a bot's alike. A tap reads the
 * conversation back to the message and shows it; one no longer there, or
 * that could not be read, says so in the block, and the second can be
 * tapped again.
 */
export function BubbleQuotes({
  quotes,
  ink,
}: {
  readonly quotes: ReadonlyArray<MessageQuote>;
  /** The bubble's text color class, which the blocks and comments take. */
  readonly ink: "text-bubble-operator-foreground" | "text-bubble-bot-foreground";
}) {
  if (quotes.length === 0) return null;
  return (
    <View className="gap-1.5">
      {quotes.map((quote) => (
        <View key={quoteKey(quote)} className="gap-1">
          <QuoteBlock quote={quote} ink={ink} />
          {quote.comment !== undefined && (
            <Text selectable className={`text-base ${ink}`}>
              {quote.comment}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

function QuoteBlock({
  quote,
  ink,
}: {
  readonly quote: MessageQuote;
  readonly ink: "text-bubble-operator-foreground" | "text-bubble-bot-foreground";
}) {
  const { t } = usePresentation().i18n;
  const quoting = useQuoting();
  const author = useAuthor()(quote);
  const color = useColor(
    ink === "text-bubble-operator-foreground"
      ? "accent-bubble-operator-foreground"
      : "accent-bubble-bot-foreground",
  );
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
      className="gap-0.5 overflow-hidden rounded-lg px-2.5 py-1.5"
    >
      {/* The bubble's ink, faint, under the block: the same in any bubble and theme. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: 0.09 }]}
      />
      <AuthorLine
        name={author.name}
        bot={author.bot}
        quoteIsBot={quote.author._tag === "bot"}
        className={ink}
      />
      <Text
        numberOfLines={2}
        className={`text-sm ${ink} ${lost === null ? "opacity-75" : "italic opacity-75"}`}
      >
        {shown}
      </Text>
    </PressScale>
  );
}

/**
 * What the draft quotes, inside the composer above its text: each a compact
 * chip, a reply's arrow or a passage's quote mark, its author's face (or
 * "You"), and the start of what it quotes on one line, then a pencil on a
 * passage for the operator's comment, where the server takes one
 * (`onComment`), and an × that takes it out. The draft takes no change while
 * it is `frozen`.
 */
export function DraftQuotes({
  quotes,
  frozen,
  onRemove,
  onComment,
}: {
  readonly quotes: ReadonlyArray<MessageQuote>;
  readonly frozen: boolean;
  /** Takes the quote at `index` of `quotes` out of the draft. */
  readonly onRemove: (index: number) => void;
  /** Sets the operator's comment on the passage at `index`; empty takes it off. */
  readonly onComment: ((index: number, comment: string) => void) | undefined;
}) {
  const { t } = usePresentation().i18n;
  const authorOf = useAuthor();
  const [editing, setEditing] = useState<number | null>(null);
  if (quotes.length === 0) return null;
  const edited = editing === null ? undefined : quotes[editing];
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // A tap on a chip's buttons does its work without closing the keyboard.
        keyboardShouldPersistTaps="always"
        accessibilityLabel={t("quote.drafted")}
        contentContainerClassName="gap-1 px-1 pt-1"
      >
        {quotes.map((quote, index) => {
          const author = authorOf(quote);
          const reply = quote.quoted._tag === "message";
          const words = quoteText(quote) === "" ? t("quote.files") : quoteText(quote);
          const what = reply
            ? quote.author._tag === "operator"
              ? t("quote.replyingToYou")
              : t("quote.replyingTo", { name: author.name })
            : t("quote.quoting", { name: author.name });
          return (
            <View
              key={quoteKey(quote)}
              accessible={false}
              className="h-9 flex-row items-center gap-1 rounded-md bg-muted ps-2"
            >
              <Icon icon={reply ? Reply : Quote} size={14} color="accent-muted-foreground" />
              {author.bot === null ? (
                <Text className="text-xs font-medium text-foreground">{author.name}</Text>
              ) : (
                <BotAvatar
                  avatar={author.bot.profile.avatar}
                  seed={author.bot.id}
                  state="idle"
                  size={FACE}
                  still
                />
              )}
              <Text
                numberOfLines={1}
                accessibilityLabel={`${what}: ${words}`}
                style={{ maxWidth: 180 }}
                className="text-xs text-foreground"
              >
                {words}
              </Text>
              {onComment !== undefined && !reply && (
                <ChipButton
                  icon={Pencil}
                  label={
                    quote.comment === undefined ? t("quote.comment.add") : t("quote.comment.edit")
                  }
                  disabled={frozen}
                  marked={quote.comment !== undefined}
                  onPress={() => setEditing(index)}
                />
              )}
              <ChipButton
                icon={X}
                label={reply ? t("quote.cancelReply") : t("quote.remove")}
                disabled={frozen}
                marked={false}
                onPress={() => onRemove(index)}
              />
            </View>
          );
        })}
      </ScrollView>
      <Sheet
        open={edited !== undefined}
        title={t("quote.comment.label")}
        onClose={() => setEditing(null)}
      >
        {edited !== undefined && editing !== null && onComment !== undefined && (
          <CommentForm
            passage={quoteText(edited)}
            initial={edited.comment ?? ""}
            onSave={(comment) => {
              onComment(editing, comment);
              setEditing(null);
            }}
          />
        )}
      </Sheet>
    </>
  );
}

/** The operator's comment on a passage they quote, under the passage it is on: optional words, and Save. */
function CommentForm({
  passage,
  initial,
  onSave,
}: {
  readonly passage: string;
  readonly initial: string;
  /** The words as written; empty takes a comment off. */
  readonly onSave: (comment: string) => void;
}) {
  const { t } = usePresentation().i18n;
  const [text, setText] = useState(initial);
  return (
    <View className="gap-3">
      <Text numberOfLines={3} className="text-sm text-muted-foreground">
        “{passage}”
      </Text>
      <TextInput
        // The sheet opened to write it: it takes the focus.
        autoFocus
        multiline
        value={text}
        maxLength={MAX_QUOTE_COMMENT_LENGTH}
        placeholder={t("quote.comment.placeholder")}
        accessibilityLabel={t("quote.comment.label")}
        onChangeText={setText}
        className="max-h-40 min-h-20 rounded-lg border border-border bg-background px-3 py-2.5 text-base text-foreground"
      />
      <Button label={t("quote.comment.save")} variant="primary" onPress={() => onSave(text)} />
    </View>
  );
}

/** One of a chip's buttons, in a full touch box: its pencil, or its ×. */
function ChipButton({
  icon,
  label,
  disabled,
  marked,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly disabled: boolean;
  /** A comment is there: the pencil is drawn in the text's color. */
  readonly marked: boolean;
  readonly onPress: () => void;
}) {
  return (
    <PressScale
      depth="round"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      hitSlop={6}
      className="size-8 items-center justify-center rounded-full active:bg-muted-strong"
    >
      <Icon
        icon={icon}
        size={15}
        color={marked ? "accent-foreground" : "accent-muted-foreground"}
      />
    </PressScale>
  );
}
