// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Section } from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { ChevronDown } from "lucide-react-native";
import { type ComponentRef, useEffect, useRef } from "react";
import { I18nManager, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useI18n } from "../i18n.ts";
import { useReducedMotion } from "../motion.ts";
import { feelLongPress } from "../platform/haptics.ts";
import { PressScale } from "../press.tsx";
import { SECTION_EMPTY_HEIGHT, SECTION_HEIGHT } from "../screens/rosterEntries.ts";
import { Text } from "../text.tsx";
import { Icon } from "./Icon.tsx";
import type { MenuAnchor } from "./Menu.tsx";

const pop = reanimatedSpring(springs.pop);

/**
 * A section's header in the roster: its name, quiet, over the bots it holds,
 * with a chevron at its end that turns as it folds. A press folds or opens
 * it; folded, it says how many bots it holds and shows a dot while one of
 * them has something unread. A long press opens its menu.
 */
export function SectionHeader({
  section,
  count,
  unread,
  folded,
  onToggle,
  onMenu,
  lifted = false,
}: {
  readonly section: Section;
  readonly count: number;
  readonly unread: boolean;
  readonly folded: boolean;
  readonly onToggle?: () => void;
  readonly onMenu?: (anchor: MenuAnchor) => void;
  /** Drawn again over its menu's scrim, where it is, without the list's inset. */
  readonly lifted?: boolean;
}) {
  const { t, plural } = useI18n();
  const reduced = useReducedMotion();
  const header = useRef<ComponentRef<typeof PressScale>>(null);
  // Folded points the chevron along the line, toward the end, the way a closed group does.
  const turned = useSharedValue(folded ? 1 : 0);
  useEffect(() => {
    const to = folded ? 1 : 0;
    turned.set(reduced ? to : withSpring(to, pop));
  }, [folded, reduced, turned]);
  const quarter = I18nManager.isRTL ? 90 : -90;
  const turning = useAnimatedStyle(() => ({
    transform: [{ rotate: `${quarter * turned.get()}deg` }],
  }));
  return (
    <PressScale
      ref={header}
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={[
        t("roster.section", { name: section.name }),
        plural("roster.section.count", count),
        folded && unread ? t("roster.unread") : null,
      ]
        .filter((part) => part !== null)
        .join(", ")}
      accessibilityState={{ expanded: !folded }}
      onPress={onToggle}
      onLongPress={
        onMenu === undefined
          ? undefined
          : () => {
              feelLongPress();
              header.current?.measureInWindow((x, y, width, height) =>
                onMenu({ x, y, width, height }),
              );
            }
      }
      className={`${lifted ? "" : "mx-2"} flex-row items-end gap-2 rounded-lg px-3 pb-2 active:bg-muted`}
      style={{ height: SECTION_HEIGHT }}
    >
      <Text
        numberOfLines={1}
        className="min-w-0 shrink text-sm font-semibold text-muted-foreground"
      >
        {section.name}
      </Text>
      {folded && <Text className="text-sm text-muted-foreground">{count}</Text>}
      {folded && unread && <View className="mb-1.5 size-1.5 rounded-pill bg-accent" />}
      <View className="flex-1" />
      <Animated.View style={turning}>
        <Icon icon={ChevronDown} size={16} color="accent-muted-foreground" />
      </Animated.View>
    </PressScale>
  );
}

/** What an open section with no bots shows: that it has none, in the rows' place. */
export function SectionEmpty() {
  const { t } = useI18n();
  return (
    <View className="mx-2 justify-center px-3" style={{ height: SECTION_EMPTY_HEIGHT }}>
      <Text className="text-sm text-muted-foreground">{t("roster.section.empty")}</Text>
    </View>
  );
}
