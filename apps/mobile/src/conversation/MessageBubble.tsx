// SPDX-License-Identifier: AGPL-3.0-or-later
import { messageStatus } from "@j3-bots/client-runtime";
import {
  fileIcon,
  type FileIcon,
  type GroupPosition,
  type TimelineMessage,
} from "@j3-bots/client-runtime/presentation";
import { deliveryLine, fileDetail } from "@j3-bots/client-runtime/wording";
import type { Attachment, Bot } from "@j3-bots/contracts";
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  type LucideIcon,
} from "lucide-react-native";
import { createContext, use, useEffect, useRef } from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import { AvatarShape } from "../components/Avatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { MessageText } from "./MessageText.tsx";

/** The widest a bubble and a card grow in the conversation's column, in px. */
export const EntryWidths = createContext({ bubble: 0, card: 0 });

// Only the corners where bubbles of one group meet tighten, on the speaker's side.
const operatorCorners = {
  single: "",
  first: "rounded-br-sm",
  middle: "rounded-r-sm",
  last: "rounded-tr-sm",
} as const satisfies Record<GroupPosition, string>;
const botCorners = {
  single: "",
  first: "rounded-bl-sm",
  middle: "rounded-l-sm",
  last: "rounded-tl-sm",
} as const satisfies Record<GroupPosition, string>;

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
 * light. Under each of the operator's messages, how it fares; one that failed
 * offers Send again, and one this device could not send offers Delete too.
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
}: {
  readonly message: TimelineMessage;
  readonly position: GroupPosition;
  /** In a room, who said a bot's message: shown above the first bubble of its group. */
  readonly speaker?: Bot | null;
  /** The names the message addressed, which `@Name` highlights. */
  readonly mentionable?: ReadonlyArray<string>;
  readonly onRetry: () => void;
  readonly onDiscard?: () => void;
  /** A retry is on its way: Send again takes no second one. */
  readonly submitting?: boolean;
  /** The members it mentions who left the room, for which the server refused it. */
  readonly leftRoom?: ReadonlyArray<string>;
  /** What Send again says when it sends somewhere else than the message did. */
  readonly retryLabel?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const widths = use(EntryWidths);
  const fromOperator = message._tag === "outgoing" || message.author._tag === "operator";
  const startsGroup = position === "single" || position === "first";
  const status = messageStatus(message);
  const failed = status._tag === "failed" || status._tag === "not-sent";
  const troubled = failed || status._tag === "unrecorded";
  const delivery = fromOperator ? deliveryLine(status, { submitting, leftRoom }, i18n) : null;
  useAnnounced(delivery);
  return (
    <View
      className={`gap-1 px-4 ${fromOperator ? "items-end" : "items-start"} ${startsGroup ? "mt-2" : "mt-0.5"}`}
    >
      {speaker !== null && startsGroup && (
        <View className="flex-row items-center gap-1.5 ps-1 pt-1">
          <AvatarShape avatar={speaker.profile.avatar} size={20} />
          <Text className="text-xs font-medium text-foreground">{speaker.profile.name}</Text>
        </View>
      )}
      {message.text !== "" && (
        <View
          style={{ maxWidth: widths.bubble }}
          className={`rounded-bubble px-3.5 py-2 ${
            fromOperator
              ? `bg-bubble-operator ${operatorCorners[position]}`
              : `bg-bubble-bot ${botCorners[position]}`
          }`}
        >
          <MessageText
            text={message.text}
            mentionable={mentionable}
            className={
              fromOperator ? "text-bubble-operator-foreground" : "text-bubble-bot-foreground"
            }
          />
        </View>
      )}
      {message.attachments.map((attachment) => (
        <AttachmentRow key={attachment.id} attachment={attachment} />
      ))}
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
    </View>
  );
}

const kindIcons = {
  image: FileImage,
  text: FileText,
  archive: FileArchive,
  code: FileCode,
  other: File,
} as const satisfies Record<FileIcon, LucideIcon>;

/** A file in the conversation: name, kind and size. */
function AttachmentRow({ attachment }: { readonly attachment: Attachment }) {
  const i18n = useI18n();
  const widths = use(EntryWidths);
  return (
    <View
      style={{ width: Math.min(256, widths.bubble) }}
      className="flex-row items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
    >
      <View className="size-8 items-center justify-center rounded-md bg-muted">
        <Icon icon={kindIcons[fileIcon(attachment.mediaType)]} color="accent-muted-foreground" />
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm font-medium text-foreground">
          {attachment.name}
        </Text>
        <Text className="text-xs text-muted-foreground">{fileDetail(attachment, i18n)}</Text>
      </View>
    </View>
  );
}
