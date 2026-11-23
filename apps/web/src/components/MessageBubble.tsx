// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment, Avatar, Bot } from "@j3-bots/contracts";
import { eases, springs } from "@j3-bots/design-tokens";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { messageStatus } from "@j3-bots/client-runtime";
import {
  clockTime,
  type GroupPosition,
  type OpeningHold,
  type TimelineMessage,
} from "@j3-bots/client-runtime/presentation";
import { usePresentation } from "../app/context";
import { deliveryLine } from "@j3-bots/client-runtime/wording";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { play } from "../lib/motion";
import { useFocusAfterActions } from "../lib/useFocusAfterActions";
import { BotAvatar } from "./avatar/BotAvatar";
import { FileCard } from "./FileCard";
import { MessageText } from "./MessageText";
import { Button } from "./ui/button";

// On the speaker's side, the bottom corner tightens, pointing at who spoke, and so does the top
// corner where a bubble meets the one above it in a group.
const operatorCorners: Record<GroupPosition, string> = {
  single: "rounded-br-sm",
  first: "rounded-br-sm",
  middle: "rounded-r-sm",
  last: "rounded-r-sm",
};
const botCorners: Record<GroupPosition, string> = {
  single: "rounded-bl-sm",
  first: "rounded-bl-sm",
  middle: "rounded-l-sm",
  last: "rounded-l-sm",
};

// A bot's text shows from the top down, a soft edge sweeping over it, at a reading pace: the
// bubble has its full size from the start, so nothing below it moves.
const revealMask = {
  maskImage: "linear-gradient(to bottom, #000 45%, transparent 55%)",
  maskSize: "100% 220%",
  maskRepeat: "no-repeat",
};
const revealTime = (text: string) => Math.min(1100, Math.max(320, text.length * 6));

interface MessageBubbleProps {
  /** A message the server has, or one of the operator's still on its way from this device. */
  readonly message: TimelineMessage;
  readonly position: GroupPosition;
  /**
   * In a room, who said it: shown above the first bubble of a bot's group, by
   * name and shape only. What the bot is doing now is not part of an old message.
   */
  readonly speaker?: Bot | null;
  /** The names the message addressed, which `@Name` highlights; `everyone` for every member. */
  readonly mentionable?: ReadonlyArray<string>;
  readonly onOpenAttachment: (attachment: Attachment) => void;
  /** Sends again a message that failed, or that this device could not send. */
  readonly onRetry: () => void;
  /** Takes a message this device could not send out of the conversation. */
  readonly onDiscard?: () => void;
  /** A retry is on its way: Send again takes no second one. */
  readonly submitting?: boolean;
  /**
   * The names of the members the message mentions who have left the room,
   * for which the server refused it: said in place of the refusal. Send
   * again then sends it without them.
   */
  readonly leftRoom?: ReadonlyArray<string>;
  /** What Send again says when it sends somewhere else than the message did, as without them. */
  readonly retryLabel?: string;
  /** The bot whose color a bot's bubble takes; the neutral bubble when it is not known. */
  readonly tint?: Avatar | null;
  /**
   * It just arrived at the end of the conversation: it settles into place, the
   * operator's flying from the composer, `flyFrom`, and a bot's text revealing.
   */
  readonly arriving?: boolean;
  readonly flyFrom?: RefObject<HTMLElement | null>;
  /** What holds the bot's hello back, which a message the server says waits behind it waits for. */
  readonly openingHold?: OpeningHold | null;
}

/** One message: the operator's on the right and dark, a bot's on the left in a tint of its color. */
export function MessageBubble({
  message,
  position,
  speaker = null,
  mentionable,
  onOpenAttachment,
  onRetry,
  onDiscard,
  submitting = false,
  leftRoom,
  retryLabel,
  tint = null,
  arriving = false,
  flyFrom,
  openingHold = null,
}: MessageBubbleProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const fromOperator = message._tag === "outgoing" || message.author._tag === "operator";
  const startsGroup = position === "single" || position === "first";
  const time = clockTime(message.createdAt, ctx);
  const status = messageStatus(message);
  const failed = status._tag === "failed" || status._tag === "not-sent";
  // The device could not record what the server answered: a problem, though nothing to retry.
  const troubled = failed || status._tag === "unrecorded";
  const deliveryText = deliveryLine(
    status,
    { submitting, leftRoom: leftRoom ?? [], openingHold },
    ctx,
  );
  // Sent again, Send again goes; focus that was on it moves to the message, which stays whatever
  // its delivery line then says, even nothing.
  const { target, actions } = useFocusAfterActions<HTMLDivElement>(failed);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Only on mount: a message arrives once.
  const arrival = useRef(arriving);
  useLayoutEffect(() => {
    const row = target.current;
    if (!arrival.current || row === null) return;
    const bubble = bubbleRef.current;
    const from = fromOperator ? (flyFrom?.current ?? null) : null;
    if (bubble !== null && from !== null) {
      // From where it was typed to where it lands, shrunk a little on the way.
      const start = from.getBoundingClientRect();
      const end = bubble.getBoundingClientRect();
      const dx = start.left + start.width - (end.left + end.width);
      const dy = start.top - end.top;
      play(
        bubble,
        [
          { transform: `translate(${dx}px, ${dy}px) scale(0.72)`, opacity: 0.7 },
          { transform: "none", opacity: 1 },
        ],
        springs.pop,
      );
      return;
    }
    play(
      row,
      [
        { opacity: 0, transform: "translateY(12px) scale(0.94)" },
        { opacity: 1, transform: "none" },
      ],
      springs.soft,
    );
    if (bubble !== null && !fromOperator) {
      const reveal = bubble.firstElementChild;
      if (reveal !== null) {
        play(
          reveal,
          [
            { ...revealMask, maskPosition: "0 100%" },
            { ...revealMask, maskPosition: "0 0" },
          ],
          { duration: revealTime(message.text), easing: eases.out },
        );
      }
    }
  }, [target, fromOperator, flyFrom, message.text]);
  return (
    <div
      ref={target}
      tabIndex={-1}
      className={cn(
        "flex flex-col gap-1 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        fromOperator ? "origin-bottom-right items-end" : "origin-bottom-left items-start",
        startsGroup ? "mt-3" : "mt-1",
      )}
    >
      {speaker && startsGroup && (
        <div className="flex items-center gap-1.5 ps-1 pt-1">
          <BotAvatar
            avatar={speaker.profile.avatar}
            seed={speaker.id}
            state="idle"
            size={24}
            still
          />
          <span className="text-xs font-medium">{speaker.profile.name}</span>
        </div>
      )}
      {message.text !== "" && (
        <div
          ref={bubbleRef}
          title={time}
          className={cn(
            "max-w-(--layout-bubble-width) rounded-bubble px-3.5 py-2 text-base pointer-coarse:text-lg",
            fromOperator
              ? [
                  "origin-bottom-right bg-bubble-operator text-bubble-operator-foreground",
                  operatorCorners[position],
                ]
              : [
                  tintOf(tint),
                  "bg-(--tint-bubble) text-bubble-bot-foreground",
                  botCorners[position],
                ],
          )}
        >
          <MessageText text={message.text} mentionable={mentionable ?? []} />
        </div>
      )}
      {message.attachments.map((attachment) => (
        <FileCard
          key={attachment.id}
          attachment={attachment}
          onOpen={() => onOpenAttachment(attachment)}
        />
      ))}
      {fromOperator && (
        // How the operator's message fares. Its text is a live region from the moment the message
        // is queued, so a change to it, such as a failure, is announced once, and Send again is not
        // read as part of it. A delivered message leaves it empty, and empty it takes no room.
        <div
          className={cn(
            "flex max-w-(--layout-bubble-width) flex-wrap items-center justify-end gap-x-1 text-end text-2xs",
            deliveryText === null && "absolute",
          )}
        >
          <span
            role="status"
            className={cn(
              troubled && !submitting ? "text-blocked" : "text-muted-foreground",
              // Its end padding sets the text on the line Send again's text ends on.
              !failed && "pe-1",
            )}
          >
            {deliveryText}
          </span>
          {failed && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 border-0 px-1 text-2xs"
              aria-disabled={submitting}
              onClick={() => {
                if (!submitting) onRetry();
              }}
              {...actions}
            >
              {retryLabel ?? t("message.retry")}
            </Button>
          )}
          {status._tag === "not-sent" && onDiscard && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 border-0 px-1 text-2xs"
              onClick={onDiscard}
              {...actions}
            >
              {t("message.discard")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
