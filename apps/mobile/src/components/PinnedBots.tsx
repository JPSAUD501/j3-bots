// SPDX-License-Identifier: AGPL-3.0-or-later
import { needsOperator } from "@j3-bots/client-runtime";
import type { BotItem } from "@j3-bots/client-runtime/presentation";
import { rosterLine } from "@j3-bots/client-runtime/wording";
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { type ComponentRef, useRef, useState } from "react";
import { View } from "react-native";
import Animated, {
  LayoutAnimationConfig,
  LinearTransition,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import { useI18n } from "../i18n.ts";
import { feelLongPress } from "../platform/haptics.ts";
import { usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { PIN_AVATAR, PIN_BAND } from "../screens/rosterEntries.ts";
import { Text } from "../text.tsx";
import { LiveBotAvatar } from "./avatar/mood.tsx";
import type { MenuAnchor } from "./Menu.tsx";

const pop = reanimatedSpring(springs.pop);
const slide = reanimatedSpring(springs.slide);

/** A bot pinned now pops in; one unpinned shrinks away; the others make room on `slide`. */
const arriving = ZoomIn.springify()
  .mass(pop.mass)
  .stiffness(pop.stiffness)
  .damping(pop.damping)
  .withInitialValues({ transform: [{ scale: 0.6 }] });
const leaving = ZoomOut.duration(motion.state);
const making = LinearTransition.springify()
  .mass(slide.mass)
  .stiffness(slide.stiffness)
  .damping(slide.damping);

/**
 * The bots the operator pinned, as large avatars with their names under them
 * in a band at the top of the roster, `columns` to a line and centred when
 * fewer. Each opens its conversation; a long press opens its menu. Unread and
 * what a bot needs show in its avatar, as in a row, and its name turns
 * semibold while it needs the operator. Nothing moves when the band first
 * appears; then a bot pinned pops in, one unpinned shrinks away, and the
 * others make room.
 */
export function PinnedBots({
  bots,
  columns,
  width,
  height,
  selectedKey,
  onOpen,
  onMenu,
}: {
  readonly bots: ReadonlyArray<BotItem>;
  readonly columns: number;
  /** The list's width, which the columns share. */
  readonly width: number;
  /** The band's height, as the list counts it (`pinnedHeight`). */
  readonly height: number;
  /** The bot whose conversation is open beside the roster, by roster key. */
  readonly selectedKey: string | null;
  readonly onOpen: (item: BotItem) => void;
  readonly onMenu: (item: BotItem, anchor: MenuAnchor) => void;
}) {
  const { t } = useI18n();
  const cellWidth = (width - 2 * PIN_BAND.inset) / columns;
  return (
    <View
      accessibilityRole="list"
      {...(bots.length === 0 ? {} : { accessibilityLabel: t("roster.pinned") })}
      className="flex-row flex-wrap justify-center overflow-visible"
      style={{
        height,
        paddingTop: bots.length === 0 ? 0 : PIN_BAND.top,
        paddingHorizontal: PIN_BAND.inset,
        rowGap: PIN_BAND.rowGap,
      }}
    >
      <LayoutAnimationConfig skipEntering skipExiting>
        {bots.map((item) => (
          <Animated.View
            key={item.bot.id}
            entering={arriving}
            exiting={leaving}
            layout={making}
            style={{ width: cellWidth, height: PIN_BAND.cell }}
          >
            <PinnedBot
              item={item}
              selected={selectedKey === `bot:${item.bot.id}`}
              onOpen={() => onOpen(item)}
              onMenu={(anchor) => onMenu(item, anchor)}
            />
          </Animated.View>
        ))}
      </LayoutAnimationConfig>
    </View>
  );
}

/** One pinned bot: its avatar, large, and its name. */
export function PinnedBot({
  item,
  selected,
  onOpen,
  onMenu,
}: {
  readonly item: BotItem;
  readonly selected: boolean;
  readonly onOpen?: () => void;
  readonly onMenu?: (anchor: MenuAnchor) => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const { bot } = item;
  const line = rosterLine(item, ctx);
  const needs = needsOperator(item);
  const cell = useRef<ComponentRef<typeof View>>(null);
  // The avatar's light keeps its ring in the color under it, which turns muted while pressed.
  const [pressed, setPressed] = useState(false);
  return (
    <PressScale
      ref={cell}
      depth="control"
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={[
        bot.profile.name,
        bot.primary ? t("roster.primary") : null,
        line.text,
        item.unread ? t("roster.unread") : null,
      ]
        .filter((part) => part !== null)
        .join(", ")}
      onPress={onOpen}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      {...(onMenu === undefined
        ? {}
        : {
            onLongPress: () => {
              feelLongPress();
              cell.current?.measureInWindow((x, y, width, height) =>
                onMenu({ x, y, width, height }),
              );
            },
          })}
      className={`items-center gap-2 rounded-lg px-1 active:bg-muted ${selected ? "bg-muted" : ""}`}
      style={{ height: PIN_BAND.cell }}
    >
      <LiveBotAvatar
        bot={bot}
        unread={item.unread}
        lastEntry={item.lastEntry}
        size={PIN_AVATAR}
        ground={selected || pressed ? "muted" : "background"}
        markPrimary
      />
      <Text
        numberOfLines={1}
        className={`max-w-full text-sm text-foreground ${needs ? "font-semibold" : "font-medium"}`}
      >
        {bot.profile.name}
      </Text>
    </PressScale>
  );
}
