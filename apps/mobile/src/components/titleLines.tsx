// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import type { TextLines } from "../lines.tsx";
import type { TitleLines } from "../screens/rosterEntries.ts";
import { Text } from "../text.tsx";
import { ROW_TEXT_INSET } from "./RosterRow.tsx";

/** A roster row shows two lines of a bot's title at most. */
const MOST = 2;

/** The titles read, and the width and the font size they were read at. */
interface Read {
  readonly width: number;
  readonly lines: TextLines;
  readonly titles: ReadonlyMap<string, number>;
}

const none: ReadonlyMap<string, number> = new Map();

/**
 * How many lines each bot's title takes in a roster row of a list `width` px
 * wide, at the operator's font size (`lines`), read from each title as this
 * phone draws it, so each row's height is known before the row is drawn
 * (`RosterSizes`). `probe` draws the titles not read yet where nothing shows
 * them; place it anywhere in the screen. A title counts as one line until it
 * is read, and every title is read again once the width or the font size
 * changes.
 */
export function useTitleLines(
  titles: ReadonlyArray<string>,
  width: number,
  lines: TextLines | null,
): { readonly titleLines: TitleLines; readonly probe: ReactNode } {
  const textWidth = width - ROW_TEXT_INSET;
  const [read, setRead] = useState<Read | null>(null);
  const known =
    read !== null && read.width === textWidth && read.lines === lines ? read.titles : none;
  const unread = lines === null ? [] : [...new Set(titles)].filter((title) => !known.has(title));
  const record = (title: string, count: number, at: TextLines) =>
    setRead((now) => {
      const before =
        now !== null && now.width === textWidth && now.lines === at ? now.titles : none;
      return { width: textWidth, lines: at, titles: new Map(before).set(title, count) };
    });
  return {
    titleLines: (title) => known.get(title) ?? 1,
    probe:
      lines === null || unread.length === 0 ? null : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          className="absolute start-0 top-0 opacity-0"
        >
          {unread.map((title) => (
            <Text
              key={title}
              className="text-xs"
              style={{ width: textWidth }}
              onTextLayout={(event) =>
                record(title, Math.min(MOST, Math.max(1, event.nativeEvent.lines.length)), lines)
              }
            >
              {title}
            </Text>
          ))}
        </View>
      ),
  };
}
