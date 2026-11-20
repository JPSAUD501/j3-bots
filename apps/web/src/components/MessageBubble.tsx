// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttachmentId, Bot, MessageDelivery, MessageEntry } from "@j3-bots/contracts";
import { usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { clockTime } from "../lib/time";
import { useFocusAfterActions } from "../lib/useFocusAfterActions";
import type { GroupPosition } from "../presentation/timeline";
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
} as const satisfies Record<Extract<MessageDelivery, { _tag: "failed" }>["reason"], string>;

interface MessageBubbleProps {
  readonly entry: MessageEntry;
  readonly position: GroupPosition;
  /**
   * In a room, who said it: shown above the first bubble of a bot's group, by
   * name and shape only. What the bot is doing now is not part of an old message.
   */
  readonly speaker?: Bot | null;
  /** Names that `@Name` may mention. */
  readonly mentionable?: ReadonlyArray<string>;
  readonly onOpenAttachment: (id: AttachmentId) => void;
  /** Sends a message whose delivery failed again. */
  readonly onRetry: () => void;
  /** A retry is on its way: Send again takes no second one. */
  readonly submitting?: boolean;
}

/** One message: the operator's on the right and dark, a bot's on the left and light. */
export function MessageBubble({
  entry,
  position,
  speaker = null,
  mentionable,
  onOpenAttachment,
  onRetry,
  submitting = false,
}: MessageBubbleProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const fromOperator = entry.author._tag === "operator";
  const startsGroup = position === "single" || position === "first";
  const time = clockTime(entry.createdAt, ctx);
  const { delivery } = entry;
  const failed = delivery._tag === "failed";
  // A retry on its way reads as queued again, which it is about to be.
  const deliveryText =
    delivery._tag === "pending" || (failed && submitting)
      ? t("message.queued")
      : delivery._tag === "cancelled"
        ? t("message.cancelled")
        : failed
          ? t(failedKeys[delivery.reason])
          : null;
  // Sent again, Send again goes; focus that was on it moves to the message, which stays whatever
  // its delivery line then says, even nothing.
  const { target, actions } = useFocusAfterActions<HTMLDivElement>(failed);
  return (
    <div
      ref={target}
      tabIndex={-1}
      className={cn(
        "flex flex-col gap-1 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
      {entry.text !== "" && (
        <div
          title={time}
          className={cn(
            "max-w-(--layout-bubble-width) rounded-bubble px-3.5 py-2 text-base pointer-coarse:text-lg",
            fromOperator
              ? ["bg-bubble-operator text-bubble-operator-foreground", operatorCorners[position]]
              : ["bg-bubble-bot text-bubble-bot-foreground", botCorners[position]],
          )}
        >
          <MessageText text={entry.text} mentionable={mentionable ?? []} />
        </div>
      )}
      {entry.attachments.map((attachment) => (
        <FileCard
          key={attachment.id}
          attachment={attachment}
          onOpen={() => onOpenAttachment(attachment.id)}
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
              failed && !submitting ? "text-blocked" : "text-muted-foreground",
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
        </div>
      )}
    </div>
  );
}
