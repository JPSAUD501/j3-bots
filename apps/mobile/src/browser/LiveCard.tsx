// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  botsTab,
  drawnRect,
  fitted,
  NO_ZOOM,
  siteOf,
  tabFaces,
  type ViewerTab,
} from "@j3-bots/client-runtime/presentation";
import { useBrowserView } from "@j3-bots/client-runtime/react";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { AppWindow } from "lucide-react-native";
import { useEffect, useEffectEvent, useState } from "react";
import { Image, PixelRatio, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { BotCursors, type Cursors, withCursor } from "./BotCursors.tsx";
import { Faces } from "./Faces.tsx";
import { keepPicture, useLastPicture } from "./pictures.ts";
import { useViewerTabs, useWaitingBots } from "./tabs.ts";

/** The card's picture at most this tall, as a photo in the conversation is. */
const CARD_HEIGHT = 220;
/** The card asks for a small picture, at a quality that is enough for one. */
const CARD_QUALITY = 50;

/** The tab the bot is on now, or null while it is on none. */
function useBotsTab(botId: BotId): ViewerTab | null {
  const { tabs } = useViewerTabs(botId);
  return tabs === null ? null : botsTab(tabs, botId);
}

/**
 * At the end of a bot's conversation while it browses: the page in small,
 * live, with its pointer, and under it the site and the faces of the bots on
 * the tab. A press opens the live view. Once the bot leaves the tab, the
 * card stays as a still picture of the last page, until the conversation is
 * opened again.
 */
export function LiveCard({ botId, width }: { readonly botId: BotId; readonly width: number }) {
  const tab = useBotsTab(botId);
  // The last tab the card showed, which stays as a still picture once the bot is done.
  const [last, setLast] = useState<ViewerTab | null>(tab);
  if (tab !== null && tab !== last) setLast(tab);
  const shown = tab ?? last;
  if (shown === null) return null;
  return <Card botId={botId} tab={shown} live={tab !== null} width={width} />;
}

function Card({
  botId,
  tab,
  live,
  width,
}: {
  readonly botId: BotId;
  readonly tab: ViewerTab;
  readonly live: boolean;
  readonly width: number;
}) {
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  const waitsForPerson = useWaitingBots();
  const site = siteOf(tab.url);
  const open = () => navigation.push("browser", { botId, ref: tab.ref });
  return (
    <View className="px-4 py-2">
      <PressScale
        depth="control"
        accessibilityRole="button"
        accessibilityLabel={t("browser.card.open", { site: site || tab.title })}
        onPress={open}
        className="overflow-hidden rounded-xl border border-border bg-surface"
      >
        <Picture tabRef={tab.ref} address={tab.url} live={live} onIt={tab.onIt} width={width} />
        <View className="min-h-11 flex-row items-center gap-2 px-3 py-2">
          <Icon icon={AppWindow} size={16} color="accent-muted-foreground" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {site || tab.title}
          </Text>
          {live && <Text className="text-xs text-muted-foreground">{t("browser.card.live")}</Text>}
          <Faces faces={tabFaces(tab, waitsForPerson)} size={20} />
        </View>
      </PressScale>
    </View>
  );
}

/**
 * The page, live while the bot is on it and the conversation is in front:
 * a view of its own at the card's size, which closes as soon as the
 * conversation is not. Otherwise the last picture this app showed.
 */
function Picture({
  tabRef,
  address,
  live,
  onIt,
  width,
}: {
  readonly tabRef: BrowserTabRef;
  readonly address: string;
  readonly live: boolean;
  readonly onIt: ReadonlyArray<BotId>;
  readonly width: number;
}) {
  const focused = useIsFocused();
  const view = useBrowserView(live && focused ? tabRef : null, () => ({
    maxWidth: PixelRatio.getPixelSizeForLayoutSize(width),
    quality: CARD_QUALITY,
  }));
  const last = useLastPicture(tabRef);
  const [page, setPage] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const [cursors, setCursors] = useState<Cursors>(new Map());
  const cursorCame = useEffectEvent((cursor: Parameters<typeof withCursor>[1]) =>
    setCursors((now) => withCursor(now, cursor, onIt)),
  );
  useEffect(() => {
    if (view === null) return;
    const stops = [
      view.picture.subscribe(() => {
        const picture = view.picture.get();
        if (picture === null) return;
        keepPicture(tabRef, picture.jpeg, Date.now());
        // A card shows only the newest picture: the next may come at once.
        view.ack(picture.sequence);
      }),
      view.state.subscribe(() => setPage(view.state.get().viewport)),
      view.onCursor(cursorCame),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [view, tabRef]);
  const height =
    page === null ? CARD_HEIGHT : Math.min(CARD_HEIGHT, (width * page.height) / page.width);
  const drawn = page === null ? null : drawnRect(fitted({ width, height }, page), NO_ZOOM);
  return (
    <View
      className="w-full bg-muted"
      style={{ height }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {last !== null && (
        <Image source={{ uri: last.uri }} resizeMode="contain" className="size-full" />
      )}
      {view !== null && drawn !== null && page !== null && (
        <BotCursors
          cursors={cursors}
          tab={tabRef}
          address={address}
          onIt={onIt}
          drawn={drawn}
          page={page}
          held={false}
        />
      )}
    </View>
  );
}

/**
 * "See the browser", over the top of a conversation scrolled away from its
 * end, where the live card is, while the bot browses.
 */
export function BrowserPill({ botId, shown }: { readonly botId: BotId; readonly shown: boolean }) {
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  const tab = useBotsTab(botId);
  if (tab === null || !shown) return null;
  return (
    <View pointerEvents="box-none" className="absolute inset-x-0 top-2 items-center">
      <PressScale
        depth="control"
        accessibilityRole="button"
        onPress={() => navigation.push("browser", { botId, ref: tab.ref })}
        className="min-h-11 flex-row items-center gap-2 rounded-pill border border-border bg-surface px-4"
      >
        <Icon icon={AppWindow} size={16} color="accent-foreground" />
        <Text className="text-sm font-medium text-foreground">{t("browser.pill")}</Text>
      </PressScale>
    </View>
  );
}
