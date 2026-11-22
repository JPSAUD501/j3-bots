// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CodeLineTone } from "@j3-bots/client-runtime/presentation";
import { type ReactNode, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "../text.tsx";

/** The most a block of code or a summary shows before it scrolls, in px. */
const SCROLLS_FROM = 256;

const toneBackground: Record<Exclude<CodeLineTone, "quiet">, string> = {
  added: "bg-success/12",
  removed: "bg-blocked/12",
};

/** Where each line of a laid-out text sits, from its top. */
interface LineBox {
  readonly y: number;
  readonly height: number;
}

/**
 * A bounded area that scrolls once its content is taller than 256 px, with
 * its scroll bar always shown on Android, so a touch screen shows that more
 * lies past it. `label` names it for a screen reader, when it has a name.
 */
export function Scrolling({
  label,
  className,
  children,
}: {
  readonly label: string | null;
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <ScrollView
      accessibilityLabel={label ?? undefined}
      // Inside the conversation's own list: Android scrolls it only when nested scrolling is on.
      nestedScrollEnabled
      persistentScrollbar
      style={{ maxHeight: SCROLLS_FROM }}
      className={className}
    >
      {children}
    </ScrollView>
  );
}

/**
 * Code exactly as given, every line and its indentation: lines never wrap,
 * so the block scrolls sideways as well as down. It is one selectable text,
 * so selecting it copies it as given. `tones` tints each line by what it
 * says and where it stands, across the block's whole width; the text stays as
 * given, so the `+` and `-` stay and the tint is never the only mark.
 */
export function CodeBlock({
  text,
  label,
  tones,
  strong = false,
  className,
}: {
  readonly text: string;
  /** What a screen reader calls the block, when it has a name. */
  readonly label: string | null;
  readonly tones?: (lines: ReadonlyArray<string>) => ReadonlyArray<CodeLineTone | undefined>;
  /** Set in medium weight, as the path of a change still waiting. */
  readonly strong?: boolean;
  readonly className: string;
}) {
  const lines = text.split("\n");
  const lineTones = tones?.(lines);
  // The text lays its lines out itself; each tint goes where its line landed.
  const [boxes, setBoxes] = useState<ReadonlyArray<LineBox>>([]);
  return (
    <Scrolling label={label} className={className}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        persistentScrollbar
        contentContainerStyle={{ flexGrow: 1 }}
      >
        <View className="grow py-2">
          <View>
            {lineTones !== undefined &&
              boxes.map((box, index) => {
                const tone = lineTones[index];
                return tone === undefined || tone === "quiet" ? null : (
                  <View
                    // oxlint-disable-next-line react/no-array-index-key -- lines are positional: a line is its place in the text
                    key={index}
                    pointerEvents="none"
                    className={toneBackground[tone]}
                    style={{
                      position: "absolute",
                      start: 0,
                      end: 0,
                      top: box.y,
                      height: box.height,
                    }}
                  />
                );
              })}
            <Text
              selectable
              onTextLayout={(event) =>
                setBoxes(event.nativeEvent.lines.map(({ y, height }) => ({ y, height })))
              }
              className={`px-2.5 text-xs leading-5 text-foreground ${strong ? "font-medium" : ""}`}
              face="mono"
            >
              {lines.map((line, index) => (
                <Text
                  // oxlint-disable-next-line react/no-array-index-key -- lines are positional, as above
                  key={index}
                  className={lineTones?.[index] === "quiet" ? "text-muted-foreground" : ""}
                >
                  {index < lines.length - 1 ? `${line}\n` : line}
                </Text>
              ))}
            </Text>
          </View>
        </View>
      </ScrollView>
    </Scrolling>
  );
}
