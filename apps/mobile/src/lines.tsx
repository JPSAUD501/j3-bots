// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ComponentRef, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useWindowDimensions, View } from "react-native";
import { Text } from "./text.tsx";

/**
 * How tall one line of each text step a list sizes its rows by is, in dp, as
 * this phone draws it at the operator's font size. Android grows text by the
 * system's font size, and from Android 14 by less than that for larger text,
 * so a line's height is read from the text as drawn rather than worked out.
 */
export interface TextLines {
  /** `text-base`: a row's name. */
  readonly base: number;
  /** `text-sm`: a row's status line, a section's name. */
  readonly sm: number;
  /** `text-xs`: a line of a bot's title, in its row. */
  readonly xs: number;
}

let current: TextLines | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const publish = (lines: TextLines): void => {
  if (
    current !== null &&
    current.base === lines.base &&
    current.sm === lines.sm &&
    current.xs === lines.xs
  ) {
    return;
  }
  current = lines;
  for (const listener of listeners) listener();
};

/** The lines as `LineProbe` last read them; null until it first has. */
export const useTextLines = (): TextLines | null => useSyncExternalStore(subscribe, () => current);

/**
 * Reads `TextLines` from a line of each step, drawn where nothing shows it,
 * and again whenever the font size changes. Mounted once, at the root. It
 * reads in a layout effect, which the new architecture lays out before, so
 * the first screen that waits for the lines is drawn once, already sized.
 */
export function LineProbe() {
  // Draws again when the window or its font size changes, and reads the lines each time it does.
  useWindowDimensions();
  const base = useRef<ComponentRef<typeof View>>(null);
  const sm = useRef<ComponentRef<typeof View>>(null);
  const xs = useRef<ComponentRef<typeof View>>(null);
  useLayoutEffect(() => {
    let baseHeight: number | null = null;
    let smHeight: number | null = null;
    let xsHeight: number | null = null;
    const read = () => {
      if (baseHeight !== null && smHeight !== null && xsHeight !== null) {
        publish({ base: baseHeight, sm: smHeight, xs: xsHeight });
      }
    };
    base.current?.measure((_x, _y, _width, height) => {
      baseHeight = height;
      read();
    });
    sm.current?.measure((_x, _y, _width, height) => {
      smHeight = height;
      read();
    });
    xs.current?.measure((_x, _y, _width, height) => {
      xsHeight = height;
      read();
    });
  });
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      className="absolute start-0 top-0 opacity-0"
    >
      <View ref={base}>
        <Text numberOfLines={1} className="text-base">
          Ag
        </Text>
      </View>
      <View ref={sm}>
        <Text numberOfLines={1} className="text-sm">
          Ag
        </Text>
      </View>
      <View ref={xs}>
        <Text numberOfLines={1} className="text-xs">
          Ag
        </Text>
      </View>
    </View>
  );
}
