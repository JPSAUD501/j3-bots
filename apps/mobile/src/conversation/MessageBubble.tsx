// SPDX-License-Identifier: AGPL-3.0-or-later
import { messageStatus } from "@j3-bots/client-runtime";
import {
  type GroupPosition,
  type MentionName,
  type OpeningHold,
  type TimelineMessage,
} from "@j3-bots/client-runtime/presentation";
import { deliveryLine } from "@j3-bots/client-runtime/wording";
import type { Avatar, BotId } from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { use, useEffect, useEffectEvent, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Text } from "../text.tsx";
import { usePresentation } from "../presentation.tsx";

import { FileCard } from "./FileCard.tsx";
import { MessageText } from "./MessageText.tsx";
import { Speaker, speakerGutter } from "./Speaker.tsx";
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
 * each of the operator's messages, how it fares; one that failed offers Send
 * again, and one this device could not send offers Delete too.
 */
export function MessageBubble({
  message,
  position,
  speaker = null,
  mentionable = [],
  onRetry,
  onDiscard,
  submitting = false,
  leftRoom = [],
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
  /** The members it mentions who left the room, for which the server refused it. */
  readonly leftRoom?: ReadonlyArray<string>;
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
    ? deliveryLine(status, { submitting, leftRoom, openingHold }, ctx)
    : null;
  useAnnounced(delivery);
  const bubble = useTint(tint).bubble;
  const motion = useArrival(arriving, fromOperator, message.text);
  const bubbleWidth = speaker === null ? widths.bubble : Math.max(0, widths.bubble - speakerGutter);
  const said = (
    <>
      {message._tag === "message" && message.visual !== undefined && (
        <VisualCard id={message.id} visual={message.visual} />
      )}
      {message.text !== "" && (
        <View
          style={
            fromOperator
              ? { maxWidth: bubbleWidth }
              : { maxWidth: bubbleWidth, backgroundColor: bubble }
          }
          className={`rounded-bubble px-3.5 py-2 ${
            fromOperator ? `bg-bubble-operator ${operatorCorners[position]}` : botCorners[position]
          }`}
        >
          <Animated.View style={motion.words}>
            <MessageText
              text={message.text}
              mentionable={mentionable}
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
      )}
      {/* Files placed in the text stand there; others follow it. */}
      {placed === null &&
        message.attachments.map((attachment) => (
          <FileCard key={attachment.id} attachment={attachment} />
        ))}
    </>
  );
  return (
    <AnimatedView
      style={[motion.row, { transformOrigin: fromOperator ? "right bottom" : "left bottom" }]}
      className={`gap-1 px-4 ${fromOperator ? "items-end" : "items-start"} ${startsGroup ? "mt-2" : "mt-0.5"}`}
    >
      {speaker === null ? (
        said
      ) : (
        // One child of the row, so its gap stays out of the speaker's name and face, and as wide
        // as the row, so a visual stretches across it as in a bot's own conversation.
        <View className="self-stretch">
          <Speaker botId={speaker} position={position}>
            {said}
          </Speaker>
        </View>
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
