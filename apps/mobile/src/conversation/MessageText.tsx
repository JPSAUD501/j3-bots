// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Inline, parseMessageText } from "@j3-bots/client-runtime/presentation";
import { Linking, View } from "react-native";
import { Text } from "../text.tsx";

/**
 * Message text with paragraphs, code and links, in the bubble's own text
 * color (`className`). Links open in the browser.
 */
export function MessageText({
  text,
  mentionable,
  className,
}: {
  readonly text: string;
  readonly mentionable: ReadonlyArray<string>;
  readonly className: string;
}) {
  return (
    <View className="gap-2">
      {parseMessageText(text, mentionable).map((block, i) =>
        block.kind === "code" ? (
          // Blocks have no identity besides their order, which never changes for a given text.
          // oxlint-disable-next-line react/no-array-index-key -- see above
          <View key={i} className="rounded-md bg-code-background px-2.5 py-2">
            <Text selectable className={`text-xs ${className}`} face="mono">
              {block.text}
            </Text>
          </View>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
          <Text key={i} selectable className={`text-lg ${className}`}>
            {block.inlines.map((inline, j) => (
              // oxlint-disable-next-line react/no-array-index-key -- inlines are positional
              <InlinePart key={j} inline={inline} />
            ))}
          </Text>
        ),
      )}
    </View>
  );
}

function InlinePart({ inline }: { readonly inline: Inline }) {
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
      return <Text className="font-semibold">@{inline.name}</Text>;
  }
}
