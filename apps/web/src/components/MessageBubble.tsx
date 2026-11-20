// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment, Bot } from "@j3-bots/contracts";
import { type IntentFailure, type MessageStatus, messageStatus } from "@j3-bots/client-runtime";
import { usePresentation } from "../app/context";
import type { KeyWith } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { clockTime } from "../lib/time";
import { useFocusAfterActions } from "../lib/useFocusAfterActions";
import type { GroupPosition, TimelineMessage } from "../presentation/timeline";
import { AvatarShape } from "./BotAvatar";
import { FileCard } from "./FileCard";
import { MessageText } from "./MessageText";
import { Button } from "./ui/button";

// Only the corners where bubbles of one group meet tighten, on the speaker's side.
const operatorCorners: Record<GroupPosition, string> = {
  single: "",
  first: "rounded-br-sm",
  middle: "rounded-r-sm",
  last: "rounded-tr-sm",
};
const botCorners: Record<GroupPosition, string> = {
  single: "",
  first: "rounded-bl-sm",
  middle: "rounded-l-sm",
  last: "rounded-tl-sm",
};

const failedKeys = {
  rejected: "message.failed.rejected",
  unresolved: "message.failed.unresolved",
  stopped: "message.failed.stopped",
} as const satisfies Record<Extract<MessageStatus, { _tag: "failed" }>["reason"], KeyWith>;

const notSentKeys = {
  refused: "message.notSent.refused",
  "not-paired": "message.notSent.notPaired",
  unexpected: "message.notSent.unexpected",
} as const satisfies Record<IntentFailure["_tag"], KeyWith>;

/** What the operator reads under their message, or null when there is nothing to say. */
const statusKey = (status: MessageStatus, submitting: boolean): KeyWith | null => {
  switch (status._tag) {
    case "sending":
      return "message.sending";
    case "not-sent":
      return notSentKeys[status.failure._tag];
    case "unrecorded":
      return "message.unrecorded";
    case "queued":
      return "message.queued";
    case "delivered":
      return null;
    case "cancelled":
      return "message.cancelled";
    case "failed":
      // A retry on its way reads as queued again, which it is about to be.
      return submitting ? "message.queued" : failedKeys[status.reason];
  }
};

interface MessageBubbleProps {
  /** A message the server has, or one of the operator's still on its way from this device. */
  readonly message: TimelineMessage;
  readonly position: GroupPosition;
  /**
   * In a room, who said it: shown above the first bubble of a bot's group, by
   * name and shape only. What the bot is doing now is not part of an old message.
   */
  readonly speaker?: Bot | null;
  /** Names that `@Name` may mention. */
  readonly mentionable?: ReadonlyArray<string>;
  readonly onOpenAttachment: (attachment: Attachment) => void;
  /** Sends again a message that failed, or that this device could not send. */
  readonly onRetry: () => void;
  /** Takes a message this device could not send out of the conversation. */
  readonly onDiscard?: () => void;
  /** A retry is on its way: Send again takes no second one. */
  readonly submitting?: boolean;
}

/** One message: the operator's on the right and dark, a bot's on the left and light. */
export function MessageBubble({
  message,
  position,
  speaker = null,
  mentionable,
  onOpenAttachment,
  onRetry,
  onDiscard,
  submitting = false,
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
  const key = statusKey(status, submitting);
  const deliveryText = key === null ? null : t(key);
  // Sent again, Send again goes; focus that was on it moves to the message, which stays whatever
  // its delivery line then says, even nothing.
  const { target, actions } = useFocusAfterActions<HTMLDivElement>(failed);
  return (
    <div
      ref={target}
      tabIndex={-1}
      className={cn(
        "flex flex-col gap-1 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        fromOperator ? "items-end" : "items-start",
        startsGroup ? "mt-2" : "mt-0.5",
      )}
    >
      {speaker && startsGroup && (
        <div className="flex items-center gap-1.5 ps-1 pt-1">
          <AvatarShape avatar={speaker.profile.avatar} size={20} />
          <span className="text-xs font-medium">{speaker.profile.name}</span>
        </div>
      )}
      {message.text !== "" && (
        <div
          title={time}
          className={cn(
            "max-w-(--layout-bubble-width) rounded-bubble px-3.5 py-2 text-base pointer-coarse:text-lg",
            fromOperator
              ? ["bg-bubble-operator text-bubble-operator-foreground", operatorCorners[position]]
              : ["bg-bubble-bot text-bubble-bot-foreground", botCorners[position]],
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
              {t("message.retry")}
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
