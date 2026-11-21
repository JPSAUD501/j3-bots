// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** How long a toast stays: long enough to read twice. */
const SHOWN_FOR = 6000;

const SayContext = createContext<((text: string) => void) | null>(null);

/**
 * A short sentence about something that just happened out of view, such as a
 * change this device could not keep. It goes by itself and asks nothing:
 * what the operator can act on stays where they act. Screen readers hear it
 * once, as it comes.
 */
export function Toasts({ children }: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const next = useRef(0);
  const say = useCallback((text: string) => {
    next.current += 1;
    setShown({ id: next.current, text });
    AccessibilityInfo.announceForAccessibility(text);
  }, []);
  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), SHOWN_FOR);
    return () => clearTimeout(timer);
  }, [shown]);
  return (
    <SayContext value={say}>
      {children}
      {shown !== null && (
        <View
          pointerEvents="none"
          className="absolute inset-x-4 items-center"
          style={{ bottom: insets.bottom + 80 }}
          // Announced as it came; the visible copy is not read again.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text className="max-w-sm rounded-md bg-foreground px-3 py-2 text-sm text-background">
            {shown.text}
          </Text>
        </View>
      )}
    </SayContext>
  );
}

/** Shows a toast. */
export const useSay = (): ((text: string) => void) => {
  const say = use(SayContext);
  if (say === null) throw new Error("useSay needs Toasts above it.");
  return say;
};
