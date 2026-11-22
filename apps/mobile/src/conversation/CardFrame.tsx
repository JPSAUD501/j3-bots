// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCardAction } from "@j3-bots/client-runtime/react";
import type { EntryId } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import type { LucideIcon } from "lucide-react-native";
import { type ComponentRef, type ReactNode, use, useEffect, useRef } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { EntryWidths } from "./widths.ts";

/** Whether an answer to the card is on its way: it then takes no second one. */
export const useSubmitting = (entryId: EntryId): boolean =>
  useCardAction(entryId)?._tag === "submitting";

/**
 * Once the card no longer waits, moves a screen reader from the control the
 * operator pressed, which goes, to the line that says how the card closed.
 * `answered` marks that the operator answered here; a card closed elsewhere
 * moves nothing. Give `outcome` to that line.
 */
export function useOutcomeFocus(pending: boolean) {
  const outcome = useRef<ComponentRef<typeof Text>>(null);
  const answeredHere = useRef(false);
  const wasPending = useRef(pending);
  useEffect(() => {
    const closed = wasPending.current && !pending;
    wasPending.current = pending;
    if (closed && answeredHere.current && outcome.current !== null) {
      AccessibilityInfo.sendAccessibilityEvent(outcome.current, "focus");
    }
  }, [pending]);
  return {
    outcome,
    answered: () => {
      answeredHere.current = true;
    },
  };
}

/**
 * The frame of a card that asks the operator for something. `attention`
 * marks one still waiting, in the waiting color, and its title says so in
 * words as well. In a column narrower than a tablet the card takes the
 * whole column.
 */
export function CardFrame({
  icon,
  title,
  attention,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly attention: boolean;
  readonly children: ReactNode;
}) {
  const widths = use(EntryWidths);
  const full = widths.column < layout.breakpoints.tablet;
  return (
    <View className="mt-2 px-4">
      <View
        style={full ? undefined : { maxWidth: widths.card }}
        // The frame clips its header, so the header's fill follows the card's rounded border.
        className={`overflow-hidden rounded-md border bg-surface ${full ? "self-stretch" : "self-start"} ${attention ? "border-waiting/45" : "border-border"}`}
      >
        <View
          className={`flex-row items-center gap-2 border-b px-3 py-2 ${attention ? "border-waiting/25 bg-waiting-surface" : "border-border"}`}
        >
          <Icon
            icon={icon}
            size={14}
            color={attention ? "accent-waiting" : "accent-muted-foreground"}
          />
          <Text
            accessibilityRole="header"
            className={`text-xs font-medium ${attention ? "text-waiting" : "text-muted-foreground"}`}
          >
            {title}
          </Text>
        </View>
        <View className="gap-3 p-3">{children}</View>
      </View>
    </View>
  );
}
