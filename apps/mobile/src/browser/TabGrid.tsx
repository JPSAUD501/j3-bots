// SPDX-License-Identifier: AGPL-3.0-or-later
import { siteOf, tabFaces, type ViewerTab } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { Plus, X } from "lucide-react-native";
import type { ReactNode } from "react";
import { Image, View } from "react-native";
import { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { AnimatedView } from "../conversation/animated.ts";
import { useI18n } from "../i18n.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Faces } from "./Faces.tsx";
import { useLastPicture } from "./pictures.ts";
import { useSideSwipe } from "./swipe.ts";

/**
 * Every tab, two to a row: each with its last picture, its name and the
 * faces of the bots on it. A press shows it; a swipe sideways or its ×
 * closes it, with Undo under the list rather than a question. New opens a
 * tab at an address. A server from before shared tabs opens and closes none.
 */
export function TabGrid({
  open,
  tabs,
  shown,
  canChange,
  waitsForPerson,
  undo,
  onClose,
  onShow,
  onCloseTab,
  onNew,
}: {
  readonly open: boolean;
  readonly tabs: ReadonlyArray<ViewerTab>;
  readonly shown: BrowserTabRef | null;
  /** The person may open and close tabs. */
  readonly canChange: boolean;
  readonly waitsForPerson: ReadonlySet<BotId>;
  /** What Undo says and does, while it can. */
  readonly undo: ReactNode;
  readonly onClose: () => void;
  readonly onShow: (ref: BrowserTabRef) => void;
  readonly onCloseTab: (tab: ViewerTab) => void;
  readonly onNew: () => void;
}) {
  const { t, plural } = useI18n();
  return (
    <Sheet
      open={open}
      title={plural("browser.live.tabs", tabs.length)}
      onClose={onClose}
      footer={undo}
    >
      {canChange && (
        <View className="mb-3 flex-row justify-end">
          <PressScale
            depth="control"
            accessibilityRole="button"
            onPress={onNew}
            className="min-h-11 flex-row items-center gap-1.5 rounded-pill border border-input px-4"
          >
            <Icon icon={Plus} size={16} color="accent-foreground" />
            <Text className="text-sm font-medium text-foreground">{t("browser.grid.new")}</Text>
          </PressScale>
        </View>
      )}
      <View className="flex-row flex-wrap justify-between gap-y-3">
        {tabs.map((tab) => (
          <TabCard
            key={tab.ref}
            tab={tab}
            current={tab.ref === shown}
            canClose={canChange}
            waitsForPerson={waitsForPerson}
            onShow={() => onShow(tab.ref)}
            onClose={() => onCloseTab(tab)}
          />
        ))}
      </View>
    </Sheet>
  );
}

function TabCard({
  tab,
  current,
  canClose,
  waitsForPerson,
  onShow,
  onClose,
}: {
  readonly tab: ViewerTab;
  readonly current: boolean;
  readonly canClose: boolean;
  readonly waitsForPerson: ReadonlySet<BotId>;
  readonly onShow: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const picture = useLastPicture(tab.ref);
  const name = tab.title === "" ? siteOf(tab.url) || t("browser.panel.newTab") : tab.title;
  const offset = useSharedValue(0);
  const swipe = useSideSwipe({
    onMove: (dx) => {
      if (canClose) offset.set(dx);
    },
    onSwipe: (direction) => {
      if (canClose && direction !== null) onClose();
      else offset.set(withTiming(0));
    },
  });
  const moved = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.get() }],
    opacity: 1 - Math.min(Math.abs(offset.get()) / 240, 0.6),
  }));
  return (
    <AnimatedView style={[{ width: "48.5%" }, moved]} {...swipe}>
      <PressScale
        depth="control"
        accessibilityRole="button"
        accessibilityState={{ selected: current }}
        accessibilityLabel={name}
        accessibilityActions={
          canClose ? [{ name: "close", label: t("browser.grid.close", { title: name }) }] : []
        }
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "close") onClose();
        }}
        onPress={onShow}
        className={`overflow-hidden rounded-lg border bg-background ${current ? "border-foreground" : "border-border"}`}
      >
        <View className="aspect-[4/5] w-full bg-muted">
          {picture !== null && (
            <Image source={{ uri: picture.uri }} resizeMode="cover" className="size-full" />
          )}
        </View>
        <View className="min-h-11 flex-row items-center gap-1.5 px-2 py-1.5">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {name}
          </Text>
          <Faces faces={tabFaces(tab, waitsForPerson)} size={18} />
        </View>
      </PressScale>
      {canClose && (
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("browser.grid.close", { title: name })}
          onPress={onClose}
          className="absolute end-1 top-1 size-11 items-center justify-center"
        >
          <View className="size-6 items-center justify-center rounded-pill bg-surface/90">
            <Icon icon={X} size={14} color="accent-foreground" />
          </View>
        </PressScale>
      )}
    </AnimatedView>
  );
}
