// SPDX-License-Identifier: AGPL-3.0-or-later
import { messageStatus } from "@j3-bots/client-runtime";
import {
  canReact,
  type GroupPosition,
  isQuotable,
  lookingAtLine,
  type MentionName,
  type OpeningHold,
  type TimelineMessage,
} from "@j3-bots/client-runtime/presentation";
import { deliveryLine, type RefusedMentions } from "@j3-bots/client-runtime/wording";
import type { Avatar, BotId } from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { MonitorDot, Reply, TextQuote } from "lucide-react-native";
import {
  type ComponentProps,
  type ComponentRef,
  type ReactNode,
  type Ref,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "../components/Icon.tsx";
import { feelLongPress } from "../platform/haptics.ts";
import { Text } from "../text.tsx";
import { usePresentation } from "../presentation.tsx";

import { FileLongPress, MessageFile } from "./FileCard.tsx";
import { MessageText } from "./MessageText.tsx";
import { QuoteCards } from "./QuoteCards.tsx";
import { useHighlight, useQuoting } from "./Quotes.tsx";
import {
  type MessageAction,
  ReactionPills,
  type ReactionTarget,
  useReacting,
} from "./Reactions.tsx";
import { Speaker, speakerGutter } from "./Speaker.tsx";
import { SwipeToReply } from "./SwipeToReply.tsx";
import { VisualCard } from "./VisualCard.tsx";
import { AnimatedView } from "./animated.ts";
import { useTint } from "./tint.ts";
import { EntryWidths } from "./widths.ts";

// On the speaker's side, the bottom corner tightens, pointing at who spoke, and so does the top
// corner where a bubble meets the one above it in a group.
const operatorCorners = {
  single: "rounded-br-sm",
  first: "rounded-br-sm",
  middle: "rounded-r-sm",
  last: "rounded-r-sm",
} as const satisfies Record<GroupPosition, string>;
const botCorners = {
  single: "rounded-bl-sm",
  first: "rounded-bl-sm",
  middle: "rounded-l-sm",
  last: "rounded-l-sm",
} as const satisfies Record<GroupPosition, string>;

/** The style of a view Reanimated draws, as a message's words take as they arrive. */
type AnimatedStyle = ComponentProps<typeof Animated.View>["style"];

/** How long a bot's text takes to show as it arrives: longer for more, within reason. */
const revealTime = (text: string) => Math.min(1100, Math.max(320, text.length * 6));

/**
 * How a message arrives at the end of a conversation: the operator's rises
 * from the composer below, shrunk, and pops into place; a bot's settles in
 * softly while its text fades up at a reading pace, the bubble at its full
 * size from the start so nothing below it moves. One that was there when the
 * conversation opened plays nothing.
 */
function useArrival(arriving: boolean, fromOperator: boolean, text: string) {
  const [played] = useState(arriving);
  const enter = useSharedValue(played ? 0 : 1);
  const reveal = useSharedValue(played && !fromOperator ? 0 : 1);
  const play = useEffectEvent(() => {
    if (!played) return;
    enter.set(withSpring(1, reanimatedSpring(fromOperator ? springs.pop : springs.soft)));
    if (!fromOperator) {
      reveal.set(
        withTiming(1, { duration: revealTime(text), easing: Easing.bezier(0.2, 0.8, 0.2, 1) }),
      );
    }
  });
  // Played once, as the message mounts.
  useEffect(() => play(), []);
  const row = useAnimatedStyle(() =>
    fromOperator
      ? {
          opacity: 0.7 + 0.3 * Math.min(1, enter.get()),
          transform: [{ translateY: 40 * (1 - enter.get()) }, { scale: 0.72 + 0.28 * enter.get() }],
        }
      : {
          opacity: Math.min(1, enter.get()),
          transform: [{ translateY: 12 * (1 - enter.get()) }, { scale: 0.94 + 0.06 * enter.get() }],
        },
  );
  const words = useAnimatedStyle(() => ({
    opacity: reveal.get(),
    transform: [{ translateY: 4 * (1 - reveal.get()) }],
  }));
  return { row, words };
}

/**
 * Says each change of the delivery line once, as it happens, the way a
 * status region does on the web: not for the line a message mounts with,
 * nor when it empties.
 */
function useAnnounced(text: string | null) {
  const said = useRef(text);
  useEffect(() => {
    if (said.current === text) return;
    said.current = text;
    if (text !== null) AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

/** A compact action at the delivery line's size, in a full 44 px touch box. */
function LineAction(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      // Pressed while disabled, it stays where it is and takes no second press.
      onPress={props.disabled === true ? undefined : props.onPress}
      className="min-h-11 min-w-11 items-center justify-center px-2"
    >
      <Text className="text-2xs text-accent">{props.label}</Text>
    </Pressable>
  );
}

/**
 * One message: the operator's on the right and dark, a bot's on the left and
 * light, a bot's with the visual it showed, if any, above its words. Under
 * it, its reactions. Under each of the operator's messages, how it fares; one
 * that failed offers Send again, and one this device could not send offers
 * Delete too. A long press on a message the server keeps with its reactions
 * opens the quick bar to react to it, over its words drawn again, where they
 * can be selected. Where quotes are offered, the same menu replies to the
 * message or quotes part of it, and a swipe toward the reading direction
 * replies too. Above its words, the messages it quotes. The message a quote
 * leads to is highlighted for a moment. Under a bot's offer to record the
 * screen, a line saying to open the app on the computer, as a phone records
 * nothing.
 */
export function MessageBubble({
  message,
  position,
  speaker = null,
  mentionable = [],
  onRetry,
  onDiscard,
  submitting = false,
  refusedMentions = null,
  retryLabel,
  tint = null,
  arriving = false,
  openingHold = null,
}: {
  readonly message: TimelineMessage;
  readonly position: GroupPosition;
  /**
   * In a room, the bot that said a bot's message: its name over the first
   * bubble of its group and its face beside the last, a deleted bot's too.
   */
  readonly speaker?: BotId | null;
  /** The names the message addressed, each with whose it is, which `@Name` highlights. */
  readonly mentionable?: ReadonlyArray<MentionName>;
  readonly onRetry: () => void;
  readonly onDiscard?: () => void;
  /** A retry is on its way: Send again takes no second one. */
  readonly submitting?: boolean;
  /** What it mentions that the server refused it for, by name: said in place of the refusal. */
  readonly refusedMentions?: RefusedMentions | null;
  /** What Send again says when it sends somewhere else than the message did. */
  readonly retryLabel?: string;
  /** The bot whose color a bot's bubble takes; the neutral bubble when it is not known. */
  readonly tint?: Avatar | null;
  /** It just arrived at the end of the conversation, and settles into place. */
  readonly arriving?: boolean;
  /** What holds the bot's hello back, which a message the server says waits behind it waits for. */
  readonly openingHold?: OpeningHold | null;
}) {
  const ctx = usePresentation();
  const { i18n } = ctx;
  const { t } = i18n;
  const widths = use(EntryWidths);
  const fromOperator = message._tag === "outgoing" || message.author._tag === "operator";
  const startsGroup = position === "single" || position === "first";
  // Where the operator placed each file in the text. A message without text, or
  // kept before files were placed, shows its files after it.
  const placed =
    message.text !== "" && message.attachmentOffsets?.length === message.attachments.length
      ? message.attachmentOffsets
      : null;
  const status = messageStatus(message);
  const failed = status._tag === "failed" || status._tag === "not-sent";
  const troubled = failed || status._tag === "unrecorded";
  const delivery = fromOperator
    ? deliveryLine(status, { submitting, refusedMentions, openingHold }, ctx)
    : null;
  useAnnounced(delivery);
  const bubble = useTint(tint).bubble;
  const motion = useArrival(arriving, fromOperator, message.text);
  const bubbleWidth = speaker === null ? widths.bubble : Math.max(0, widths.bubble - speakerGutter);
  const reacting = useReacting();
  const reactable =
    message._tag === "message" && message.reactions !== undefined && canReact(message)
      ? { entryId: message.id, reactions: message.reactions }
      : null;
  const side = fromOperator ? "end" : "start";
  const quoting = useQuoting();
  const quotable =
    message._tag === "message" && quoting.offered && isQuotable(message) ? message : null;
  const reply = quotable === null ? null : () => quoting.reply(quotable);
  const actions: ReadonlyArray<MessageAction> =
    quotable === null
      ? []
      : [
          { label: t("quote.reply"), icon: Reply, onPress: () => quoting.reply(quotable) },
          // A message of files alone has no words to quote part of.
          ...(quotable.text.trim() === ""
            ? []
            : [
                {
                  label: t("quote.quotePart"),
                  icon: TextQuote,
                  onPress: () => quoting.quotePart(quotable),
                },
              ]),
        ];
  // Only a bot offers, and only what this version knows.
  const offersRecording =
    message._tag === "message" &&
    message.author._tag === "bot" &&
    message.offer?.kind === "record-screen";
  const highlight = useHighlight(message._tag === "message" ? message.id : null);
  const messageView = useRef<ComponentRef<typeof Pressable>>(null);
  const wordsView = useRef<ComponentRef<typeof View>>(null);
  // The bubble with the message's words, which a long press draws again over the quick bar's scrim.
  const words = (
    selectable: boolean,
    style: AnimatedStyle,
    ref?: Ref<ComponentRef<typeof View>>,
  ): ReactNode =>
    message.text !== "" && (
      <View
        ref={ref}
        style={
          fromOperator
            ? { maxWidth: bubbleWidth }
            : { maxWidth: bubbleWidth, backgroundColor: bubble }
        }
        className={`rounded-bubble px-3.5 py-2 ${
          fromOperator ? `bg-bubble-operator ${operatorCorners[position]}` : botCorners[position]
        }`}
      >
        <Animated.View style={style}>
          <MessageText
            text={message.text}
            mentionable={mentionable}
            selectable={selectable}
            className={
              fromOperator ? "text-bubble-operator-foreground" : "text-bubble-bot-foreground"
            }
            {...(placed === null
              ? {}
              : {
                  placed: {
                    files: message.attachments,
                    offsets: placed,
                    color: fromOperator
                      ? "accent-bubble-operator-foreground"
                      : "accent-bubble-bot-foreground",
                  },
                })}
          />
        </Animated.View>
      </View>
    );
  // Where a long press reacts, the words are selected in the bubble drawn again over the bar's
  // scrim, so selecting and reacting never answer the same press.
  const said = (
    <>
      <QuoteCards quotes={message.quotes ?? []} side={side} maxWidth={bubbleWidth} />
      {message._tag === "message" && message.visual !== undefined && (
        <VisualCard id={message.id} visual={message.visual} />
      )}
      {words(reactable === null, motion.words, wordsView)}
      {/* Files placed in the text stand there; others follow it. */}
      {placed === null &&
        message.attachments.map((attachment) => (
          <MessageFile key={attachment.id} attachment={attachment} />
        ))}
      {offersRecording && (
        // The phone records nothing: the offer says where it can be done (decision 0098).
        <View style={{ maxWidth: bubbleWidth }} className="flex-row items-start gap-1.5 ps-1">
          <Icon icon={MonitorDot} size={14} color="accent-muted-foreground" />
          <Text className="shrink text-xs text-muted-foreground">
            {t("message.offer.recordScreen.elsewhere")}
          </Text>
        </View>
      )}
    </>
  );
  const openBar = () => {
    if (reactable === null) return;
    feelLongPress();
    messageView.current?.measureInWindow((x, y, width, height) => {
      const open = (preview: ReactionTarget["preview"]) =>
        reacting.open({ ...reactable, anchor: { x, y, width, height }, side, preview, actions });
      const shown = wordsView.current;
      if (shown === null) {
        open(null);
        return;
      }
      shown.measureInWindow((atX, atY, atWidth, atHeight) =>
        open({
          at: { x: atX, y: atY, width: atWidth, height: atHeight },
          content: words(true, null),
        }),
      );
    });
  };
  // Where the operator reacts to nothing and quotes nothing, a long press opens nothing.
  const body =
    reactable === null || (!reacting.offered && actions.length === 0) ? (
      said
    ) : (
      <Pressable
        ref={messageView}
        accessibilityActions={[
          { name: "longpress", label: t("reaction.add") },
          ...(reply === null ? [] : [{ name: "reply", label: t("quote.reply") }]),
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "longpress") openBar();
          if (event.nativeEvent.actionName === "reply") reply?.();
        }}
        onLongPress={openBar}
        className={`gap-1 self-stretch ${fromOperator ? "items-end" : "items-start"}`}
      >
        <FileLongPress value={openBar}>{said}</FileLongPress>
      </Pressable>
    );
  const pills = reactable !== null && (
    <ReactionPills
      entryId={reactable.entryId}
      reactions={reactable.reactions}
      side={side}
      maxWidth={bubbleWidth}
    />
  );
  return (
    <AnimatedView
      style={[motion.row, { transformOrigin: fromOperator ? "right bottom" : "left bottom" }]}
      className={`gap-1 px-4 ${fromOperator ? "items-end" : "items-start"} ${startsGroup ? "mt-2" : "mt-0.5"}`}
    >
      {/* The highlight of a message a quote led to, across the row, behind it. */}
      <AnimatedView
        pointerEvents="none"
        style={highlight}
        className="absolute inset-0 bg-accent/12"
      />
      <SwipeToReply
        onReply={reply}
        className={`gap-1 ${fromOperator ? "items-end" : "items-start"}`}
      >
        {speaker === null ? (
          <>
            {body}
            {pills}
          </>
        ) : (
          // One child, so the gap stays out of the speaker's name and face, and as wide as the row,
          // so a visual stretches across it as in a bot's own conversation.
          <View className="self-stretch">
            <Speaker botId={speaker} position={position}>
              {body}
              {pills}
            </Speaker>
          </View>
        )}
      </SwipeToReply>
      {fromOperator && message.lookingAt !== undefined && (
        // The window the operator wrote it over, from the desktop app's quick access.
        <Text
          numberOfLines={1}
          style={{ maxWidth: widths.bubble }}
          className="text-2xs text-muted-foreground"
        >
          {t("message.lookingAt", { window: lookingAtLine(message.lookingAt) })}
        </Text>
      )}
      {delivery !== null && (
        <View
          style={{ maxWidth: widths.bubble }}
          className="flex-row flex-wrap items-center justify-end"
        >
          <Text
            className={`text-2xs ${troubled && !submitting ? "text-blocked" : "text-muted-foreground"}`}
          >
            {delivery}
          </Text>
          {failed && (
            <LineAction
              label={retryLabel ?? t("message.retry")}
              onPress={onRetry}
              disabled={submitting}
            />
          )}
          {status._tag === "not-sent" && onDiscard !== undefined && (
            <LineAction label={t("message.discard")} onPress={onDiscard} />
          )}
        </View>
      )}
    </AnimatedView>
  );
}
