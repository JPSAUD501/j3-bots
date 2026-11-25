// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Inline,
  type MentionName,
  parseMessageText,
} from "@j3-bots/client-runtime/presentation";
import type { Attachment, Bot, BotId } from "@j3-bots/contracts";
import { Linking, View } from "react-native";
import { useBots } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { InlineFile } from "./FileCard.tsx";
import { INLINE_LINE_HEIGHT } from "./inlineChip.ts";
import { MentionChip } from "./MentionChip.tsx";

/** A message's files, each drawn where it was placed in its text. */
interface PlacedFiles {
  readonly files: ReadonlyArray<Attachment>;
  /** Where each stands in the text, in their order. */
  readonly offsets: ReadonlyArray<number>;
  /** The bubble's text color, as a theme `accent-` class, which a file's chip takes. */
  readonly color: string;
}

/**
 * Message text with paragraphs, code and links, each bot it mentions as its
 * chip, and each of its files where it was placed, in the bubble's own text
 * color (`className`). Links open in the browser.
 */
export function MessageText({
  text,
  mentionable,
  className,
  placed,
}: {
  readonly text: string;
  readonly mentionable: ReadonlyArray<MentionName>;
  readonly className: string;
  readonly placed?: PlacedFiles;
}) {
  const bots = useBots();
  // A mention is a bot's chip while the bot is there; `@everyone` and a deleted bot's stay text.
  const botOf = (botId: BotId | null): Bot | undefined =>
    botId === null ? undefined : bots.get(botId);
  const chipped = (inline: Inline) =>
    inline.kind === "file" || (inline.kind === "mention" && botOf(inline.botId) !== undefined);
  return (
    <View className="gap-2">
      {parseMessageText(text, mentionable, placed?.offsets).map((block, i) =>
        block.kind === "code" ? (
          // Blocks have no identity besides their order, which never changes for a given text.
          // oxlint-disable-next-line react/no-array-index-key -- see above
          <View key={i} className="rounded-md bg-code-background px-2.5 py-2">
            <Text selectable className={`text-xs ${className}`} face="mono">
              {block.text}
            </Text>
          </View>
        ) : (
          <Text
            // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
            key={i}
            selectable
            // A chip is taller than a line of text: its lines make room for it.
            style={block.inlines.some(chipped) ? { lineHeight: INLINE_LINE_HEIGHT } : undefined}
            className={`text-lg ${className}`}
          >
            {block.inlines.map((inline, j) => (
              // oxlint-disable-next-line react/no-array-index-key -- inlines are positional
              <InlinePart key={j} inline={inline} placed={placed} botOf={botOf} />
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
  botOf,
}: {
  readonly inline: Inline;
  readonly placed: PlacedFiles | undefined;
  readonly botOf: (botId: BotId | null) => Bot | undefined;
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
    case "mention": {
      const bot = botOf(inline.botId);
      return bot === undefined ? (
        <Text className="font-semibold">@{inline.name}</Text>
      ) : (
        <MentionChip avatar={bot.profile.avatar} seed={bot.id} name={inline.name} />
      );
    }
    case "file": {
      const attachment = placed?.files[inline.index];
      return attachment === undefined ? null : (
        <InlineFile attachment={attachment} color={placed?.color ?? "accent-foreground"} />
      );
    }
  }
}
