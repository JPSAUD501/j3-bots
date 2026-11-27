// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Inline,
  type MentionName,
  parseMessageText,
} from "@j3-bots/client-runtime/presentation";
import type { Attachment, ConversationMention } from "@j3-bots/contracts";
import { Linking, View } from "react-native";
import { useBots, useRooms } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { InlineFile } from "./FileCard.tsx";
import { INLINE_LINE_HEIGHT } from "./inlineChip.ts";
import { TextMention } from "./MentionChip.tsx";

/** A message's files, each drawn where it was placed in its text. */
interface PlacedFiles {
  readonly files: ReadonlyArray<Attachment>;
  /** Where each stands in the text, in their order. */
  readonly offsets: ReadonlyArray<number>;
  /** The bubble's text color, as a theme `accent-` class, which a file's chip takes. */
  readonly color: string;
}

/**
 * Message text with paragraphs, code and links, each bot and room it
 * mentions as its chip, which opens what it names (`OpenMention`), and each
 * of its files where it was placed, in the bubble's own text color
 * (`className`). Links open in the browser. Its text can be selected unless a
 * long press on the message does something else (`selectable`).
 */
export function MessageText({
  text,
  mentionable,
  className,
  placed,
  selectable = true,
}: {
  readonly text: string;
  readonly mentionable: ReadonlyArray<MentionName>;
  readonly className: string;
  readonly placed?: PlacedFiles;
  readonly selectable?: boolean;
}) {
  const bots = useBots();
  const rooms = useRooms();
  // A mention is a chip while what it names is there; `@everyone` and a deleted one's stay text.
  const there = (of: ConversationMention | null) =>
    of !== null && (of._tag === "bot" ? bots.has(of.botId) : rooms.has(of.roomId));
  const chipped = (inline: Inline) =>
    inline.kind === "file" || (inline.kind === "mention" && there(inline.of));
  return (
    <View className="gap-2">
      {parseMessageText(text, mentionable, placed?.offsets).map((block, i) =>
        block.kind === "code" ? (
          // Blocks have no identity besides their order, which never changes for a given text.
          // oxlint-disable-next-line react/no-array-index-key -- see above
          <View key={i} className="rounded-md bg-code-background px-2.5 py-2">
            <Text selectable={selectable} className={`text-xs ${className}`} face="mono">
              {block.text}
            </Text>
          </View>
        ) : (
          <Text
            // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
            key={i}
            selectable={selectable}
            // A chip is taller than a line of text: its lines make room for it.
            style={block.inlines.some(chipped) ? { lineHeight: INLINE_LINE_HEIGHT } : undefined}
            className={`text-lg ${className}`}
          >
            {block.inlines.map((inline, j) => (
              // oxlint-disable-next-line react/no-array-index-key -- inlines are positional
              <InlinePart key={j} inline={inline} placed={placed} />
            ))}
          </Text>
        ),
      )}
    </View>
  );
}

function InlinePart({
  inline,
  placed,
}: {
  readonly inline: Inline;
  readonly placed: PlacedFiles | undefined;
}) {
  switch (inline.kind) {
    case "text":
      return inline.text;
    case "code":
      return (
        <Text className="bg-code-background" face="mono">
          {inline.text}
        </Text>
      );
    case "link":
      return (
        <Text
          accessibilityRole="link"
          className="underline"
          onPress={() => void Linking.openURL(inline.href)}
        >
          {inline.text}
        </Text>
      );
    case "mention":
      return <TextMention name={inline.name} of={inline.of} />;
    case "file": {
      const attachment = placed?.files[inline.index];
      return attachment === undefined ? null : (
        <InlineFile attachment={attachment} color={placed?.color ?? "accent-foreground"} />
      );
    }
  }
}
