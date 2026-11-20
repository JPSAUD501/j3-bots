// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttachmentId, Bot, MessageEntry } from "@j3-bots/contracts";
import { usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { clockTime } from "../lib/time";
import type { GroupPosition } from "../presentation/timeline";
import { AvatarShape } from "./BotAvatar";
import { FileCard } from "./FileCard";
import { MessageText } from "./MessageText";

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
}

/** One message: the operator's on the right and dark, a bot's on the left and light. */
export function MessageBubble({
  entry,
  position,
  speaker = null,
  mentionable,
  onOpenAttachment,
}: MessageBubbleProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const fromOperator = entry.author._tag === "operator";
  const startsGroup = position === "single" || position === "first";
  const time = clockTime(entry.createdAt, ctx);
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
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
      {fromOperator && entry.delivery._tag === "pending" && (
        <span className="pe-1 text-2xs text-muted-foreground">{t("message.queued")}</span>
      )}
      {entry.delivery._tag === "cancelled" && (
        <span className="pe-1 text-2xs text-muted-foreground">{t("message.cancelled")}</span>
      )}
    </div>
  );
}
