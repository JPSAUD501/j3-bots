// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserPicture, BrowserViewState, Readable } from "@j3-bots/client-runtime";
import {
  BROWSER_SETUP_DOCS,
  clockTime,
  followedBot,
  type Frozen,
  frozenOf,
  listedTabs,
  needsYouElsewhere,
  neighborTab,
  type ShownTab,
  shownTab,
  siteOf,
  tabComputerName,
  tabFaces,
  type ViewerTab,
  viewLiveness,
} from "@j3-bots/client-runtime/presentation";
import {
  type PageUseHandle,
  useBrowserView,
  useDevices,
  useJ3Client,
  usePageUse,
  useReadable,
  useRefusedInput,
  useSelected,
} from "@j3-bots/client-runtime/react";
import { botNames, liveLine, tabLineWords, tabOpenFailed } from "@j3-bots/client-runtime/wording";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as DateTime from "effect/DateTime";
import * as ExpoNetwork from "expo-network";
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Crosshair,
  Ellipsis,
  Globe,
  Plus,
  RotateCw,
  X,
} from "lucide-react-native";
import {
  type ComponentRef,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Image,
  Keyboard,
  PixelRatio,
  Pressable,
  StatusBar,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DocsLink } from "../components/DocsLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Menu, type MenuAnchor, type MenuEntry } from "../components/Menu.tsx";
import { Working } from "../components/States.tsx";
import { useI18n } from "../i18n.ts";
import { type Navigation, type Screens, useOpenConversation } from "../navigation.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { useSay } from "../toast.tsx";
import { Body, Button } from "../ui.tsx";
import { AddressSheet } from "./AddressSheet.tsx";
import { type Closed, useClosingTabs } from "./closing.ts";
import { Faces } from "./Faces.tsx";
import { PageDialog } from "./PageDialog.tsx";
import { PageView, type PageViewHandle } from "./PageView.tsx";
import { useLastPicture } from "./pictures.ts";
import { useSideSwipe } from "./swipe.ts";
import { TabGrid } from "./TabGrid.tsx";
import { TabSheet } from "./TabSheet.tsx";
import { useViewerTabs, useWaitingBots } from "./tabs.ts";

type Props = NativeStackScreenProps<Screens, "browser">;

/** The JPEG quality asked for on a cellular network, where every picture costs. */
const CELLULAR_QUALITY = 55;
/** How far the site's line is pulled down to close the live view. */
const PULL_TO_CLOSE = 96;

/**
 * The live view of the browser (decision 0110): the page on the whole
 * screen, only its site above it, and everything to press in a bar at the
 * bottom, in the thumb's reach: close, the page's Back, the faces and the
 * one line of who is on the tab, Now or Continue when it offers one, the
 * tabs and the menu. Touching the page is using it: the bots on the tab wait
 * and carry on by themselves once the person stops. Leaving gives the tab
 * back at once; nothing closes with the view.
 */
export function LiveScreen({ navigation, route }: Props) {
  const from = route.params.botId;
  const i18n = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const { tabs, shared } = useViewerTabs(from);
  const closing = useClosingTabs();
  const listed = tabs === null ? null : listedTabs(tabs, closing.closing);

  // The tab shown stays put as the list changes, and gives way to its neighbor once it closes.
  const [shown, setShown] = useState<{
    readonly tab: ShownTab;
    readonly list: ReadonlyArray<ViewerTab> | null;
  }>({ tab: { ref: route.params.ref ?? null, fresh: false }, list: null });
  if (listed !== shown.list && !sameTabs(listed, shown.list)) {
    setShown({
      tab: shownTab({ shown: shown.tab, before: shown.list, after: listed, from }),
      list: listed,
    });
  }
  const tab = listed?.find((each) => each.ref === shown.tab.ref) ?? null;
  // A tab just opened is waited for only while the list does not hold it yet.
  const show = (ref: BrowserTabRef, fresh = false) =>
    setShown((now) => ({
      ...now,
      tab: { ref, fresh: fresh && !(now.list?.some((each) => each.ref === ref) ?? false) },
    }));
  // Showing the page again, after another window took it or it failed to open, is a view of its own.
  const [attempt, setAttempt] = useState(0);

  const openTab = (url: string | null) => {
    void client.openBrowserTab(url).then((result) => {
      if (result._tag === "done") show(result.value, true);
      else say(tabOpenFailed(result.failure, i18n));
    });
  };

  return (
    <TabLive
      // Each tab is a view of its own: what the person did on one stays with it.
      key={`${tab?.ref ?? "none"}:${attempt}`}
      navigation={navigation}
      from={from}
      tab={tab}
      loading={listed === null || (shown.tab.fresh && tab === null)}
      tabs={listed ?? []}
      shared={shared}
      closing={closing}
      onShow={show}
      onRetry={() => setAttempt((n) => n + 1)}
      onOpenTab={openTab}
    />
  );
}

/** Whether two lists hold the same tabs, as they were: a new list from the server need not be a change. */
const sameTabs = (
  one: ReadonlyArray<ViewerTab> | null,
  other: ReadonlyArray<ViewerTab> | null,
): boolean =>
  one !== null &&
  other !== null &&
  one.length === other.length &&
  one.every((tab, index) => tab.ref === other[index]?.ref);

/**
 * The size of picture to ask for, read for each socket: the screen's width
 * and height in pixels, at a lower quality on a cellular network.
 */
function useViewSize() {
  const { width, height } = useWindowDimensions();
  const network = ExpoNetwork.useNetworkState();
  const size = useRef({ maxWidth: 0, maxHeight: 0, cellular: false });
  useEffect(() => {
    size.current = {
      maxWidth: PixelRatio.getPixelSizeForLayoutSize(Math.max(width, height)),
      maxHeight: PixelRatio.getPixelSizeForLayoutSize(Math.max(width, height)),
      cellular: network.type === ExpoNetwork.NetworkStateType.CELLULAR,
    };
  });
  return () => {
    const { maxWidth, maxHeight, cellular } = size.current;
    return cellular ? { maxWidth, maxHeight, quality: CELLULAR_QUALITY } : { maxWidth, maxHeight };
  };
}

/** Whether this device reaches the network, as far as the system knows. */
function useOnline(): boolean {
  const network = ExpoNetwork.useNetworkState();
  return network.isConnected !== false && network.isInternetReachable !== false;
}

/** What a viewer with no view yet reads. */
const IDLE: Readable<null> = { get: () => null, subscribe: () => () => undefined };

type Opened = "sheet" | "tabs" | "address" | "new" | null;

function TabLive({
  navigation,
  from,
  tab,
  loading,
  tabs,
  shared,
  closing,
  onShow,
  onRetry,
  onOpenTab,
}: {
  readonly navigation: Navigation;
  readonly from: BotId;
  readonly tab: ViewerTab | null;
  /** The tabs are still on their way, or the one just opened. */
  readonly loading: boolean;
  readonly tabs: ReadonlyArray<ViewerTab>;
  readonly shared: boolean;
  readonly closing: ReturnType<typeof useClosingTabs>;
  readonly onShow: (ref: BrowserTabRef) => void;
  /** Opens the tab's view again. */
  readonly onRetry: () => void;
  readonly onOpenTab: (url: string | null) => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const bots = useBots();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const lying = window.width > window.height;
  const waitsForPerson = useWaitingBots();
  const openConversation = useOpenConversation();

  const view = useBrowserView(tab?.ref ?? null, useViewSize());
  const state = useReadable<BrowserViewState | null>(view?.state ?? IDLE);
  const drawn = useSelected<BrowserPicture | null, boolean>(
    view?.picture ?? IDLE,
    (picture) => picture !== null,
  );
  const use = usePageUse({ tab, send: view?.send ?? null, shared });
  const online = useOnline();
  const frozen = frozenOf({ tab, online, status: viewLiveness(state) });
  const refused = useRefusedInput(view?.refused ?? null);
  const computer = tabComputerName(tab, useDevices());
  const status = state?.status._tag;
  const live = frozen._tag === "live";
  // While the tab's computer is away, the page stays on the last picture this view drew; a view
  // opened since has none, and shows the one kept for the tab.
  const showsPage =
    view !== null &&
    (live || (frozen._tag === "away" && drawn)) &&
    (status === "live" || status === "reconnecting" || status === "paused");

  // Leaving, or going to another tab, gives what this device holds back at once.
  const leave = use.leave;
  useEffect(() => navigation.addListener("beforeRemove", () => leave()), [navigation, leave]);
  const showTab = (ref: BrowserTabRef) => {
    if (ref === tab?.ref) return;
    leave();
    onShow(ref);
  };

  // A frozen page takes no typing: what reached the site before is what stands.
  const page = useRef<PageViewHandle>(null);
  useEffect(() => {
    if (!live) Keyboard.dismiss();
  }, [live]);

  // The view keeps the work of the bot at it in sight until the person moves or zooms it.
  const [following, setFollowing] = useState(true);
  const followed = tab === null ? null : followedBot(tab);
  const follow = following ? followed : null;

  const [opened, setOpened] = useState<Opened>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const more = useRef<ComponentRef<typeof View>>(null);

  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name ?? t("bot.unknown");
  const words = tabLineWords(use.line, nameOf, ctx.i18n);
  const site = siteOf(tab?.url ?? "");
  const where = site === "" ? (tab?.title ?? "") : site;
  const usable =
    status === "live" && live && tab?.holder._tag !== "elsewhere" && tab?.holder._tag !== "fill";
  // A frozen page answers nothing: its dialog waits until it is live again.
  const dialog = use.holding && live ? (state?.control?.dialog ?? null) : null;

  const closeTab = (closed: ViewerTab) =>
    closing.close({ ref: closed.ref, bots: closed.onIt } satisfies Closed);
  const step = (direction: -1 | 1) => {
    if (tab === null) return;
    const next = neighborTab(tabs, tab.ref, direction);
    if (next !== null) showTab(next.ref);
  };

  // A frozen page takes nothing: the menu offers only what is not the page's.
  const pageEntries: ReadonlyArray<MenuEntry> = [
    {
      label: t("browser.live.forward"),
      icon: ArrowRight,
      onPress: () => use.send({ type: "forward" }),
    },
    {
      label: t("browser.live.reload"),
      icon: RotateCw,
      onPress: () => use.send({ type: "reload" }),
    },
    { label: t("browser.live.goTo"), icon: Globe, onPress: () => setOpened("address") },
  ];
  const entries: ReadonlyArray<MenuEntry> = [
    ...(live ? pageEntries : []),
    ...(shared
      ? [
          { label: t("browser.live.newTab"), icon: Plus, onPress: () => setOpened("new") },
          ...(tab === null
            ? []
            : [
                {
                  label: t("browser.live.closeTab"),
                  icon: X,
                  tone: "destructive" as const,
                  onPress: () => closeTab(tab),
                },
              ]),
        ]
      : []),
  ];

  const lineText = liveLine({ frozen, line: words.text, refused, computer }, ctx.i18n);
  const undo = <UndoLine closed={closing.last} onUndo={closing.undo} />;
  const bar = (
    <LiveBar
      lying={lying}
      use={use}
      frozen={frozen}
      faces={tab === null ? [] : tabFaces(tab, waitsForPerson)}
      text={lineText}
      action={live ? words.action : null}
      tabs={tabs}
      shown={tab?.ref ?? null}
      needsYou={needsYouElsewhere(tabs, tab?.ref ?? null, waitsForPerson)}
      more={more}
      onClose={() => navigation.goBack()}
      onBack={() => use.send({ type: "back" })}
      onSheet={() => setOpened("sheet")}
      onTabs={() => setOpened("tabs")}
      onMore={() =>
        more.current?.measureInWindow((x, y, width, height) => setMenu({ x, y, width, height }))
      }
      onStep={step}
      onField={(direction) => page.current?.field(direction)}
      onDoneTyping={() => page.current?.doneTyping()}
    />
  );

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className={`flex-1 bg-background ${lying ? "flex-row" : ""}`}
    >
      <StatusBar hidden={lying} />
      <View className="flex-1">
        {!lying && <SiteLine where={where} top={insets.top} onPulled={() => navigation.goBack()} />}
        <View className="flex-1 overflow-hidden">
          {showsPage && tab !== null ? (
            <PageView
              ref={page}
              tabRef={tab.ref}
              address={tab.url}
              view={view}
              page={state?.viewport ?? null}
              usable={usable}
              send={use.send}
              onIt={tab.onIt}
              follow={follow}
              onFollowing={() => setFollowing(false)}
              holding={use.holding}
              onKeyboard={use.keyboard}
              label={t("browser.page", { site: where })}
            />
          ) : (
            <InPlace
              tab={tab}
              loading={loading}
              state={state}
              frozen={frozen}
              onShowHere={onRetry}
            />
          )}
          {showsPage && !following && followed !== null && (
            <View className="absolute inset-x-0 bottom-3 items-center" pointerEvents="box-none">
              <PressScale
                depth="control"
                accessibilityRole="button"
                onPress={() => setFollowing(true)}
                className="min-h-11 flex-row items-center gap-2 rounded-pill border border-border bg-surface px-4"
                style={{ elevation: OVERLAY_ELEVATION }}
              >
                <Icon icon={Crosshair} size={16} color="accent-foreground" />
                <Text className="text-sm font-medium text-foreground">
                  {t("browser.live.follow", { name: nameOf(followed) })}
                </Text>
              </PressScale>
            </View>
          )}
          {/* Lying, the rail has no room for words: why the page takes nothing shows over it. */}
          {lying && (frozen._tag === "away" || refused !== null) && (
            <View
              className="absolute inset-x-0 top-3 items-center"
              pointerEvents="none"
              importantForAccessibility="no-hide-descendants"
            >
              <Text
                numberOfLines={1}
                className="max-w-full rounded-pill border border-border bg-surface px-4 py-2 text-sm text-foreground"
                style={{ elevation: OVERLAY_ELEVATION }}
              >
                {lineText}
              </Text>
            </View>
          )}
          {dialog !== null && view !== null && (
            <PageDialog
              // Each dialog the page opens starts with its own default value.
              key={`${dialog.kind}:${dialog.message}:${dialog.defaultValue}`}
              dialog={dialog}
              site={where}
              onAnswer={use.send}
            />
          )}
        </View>
        {opened !== "tabs" && undo}
        {!lying && bar}
      </View>
      {lying && bar}

      {tab !== null && (
        <TabSheet
          open={opened === "sheet"}
          tab={tab}
          from={from}
          waiting={use.line._tag === "waits-until-continue"}
          waitsForPerson={waitsForPerson}
          onClose={() => setOpened(null)}
          onWaitForMe={use.waitForMe}
          onContinue={use.giveBack}
          onConversation={(botId) => {
            setOpened(null);
            navigation.goBack();
            openConversation({ _tag: "bot", botId });
          }}
        />
      )}
      <TabGrid
        open={opened === "tabs"}
        tabs={tabs}
        shown={tab?.ref ?? null}
        canChange={shared}
        waitsForPerson={waitsForPerson}
        undo={undo}
        onClose={() => setOpened(null)}
        onShow={(ref) => {
          setOpened(null);
          showTab(ref);
        }}
        onCloseTab={closeTab}
        onNew={() => setOpened("new")}
      />
      <AddressSheet
        open={opened === "address" || opened === "new"}
        title={opened === "new" ? t("browser.live.newTab") : t("browser.live.goTo")}
        onClose={() => setOpened(null)}
        onGo={(url) => {
          if (opened === "new") onOpenTab(url);
          else use.send({ type: "navigate", url });
          setOpened(null);
        }}
      />
      <Menu
        anchor={menu}
        onClose={() => setMenu(null)}
        label={t("browser.live.more")}
        entries={entries}
      />
    </KeyboardAvoidingView>
  );
}

/**
 * The site, alone above the page, which only informs. Pulled down, it closes
 * the live view, as a sheet does.
 */
function SiteLine({
  where,
  top,
  onPulled,
}: {
  readonly where: string;
  readonly top: number;
  readonly onPulled: () => void;
}) {
  // Pulled down by the finger, from where it touched.
  const from = useRef<number | null>(null);
  return (
    <View
      onStartShouldSetResponder={(event) => {
        from.current = event.nativeEvent.pageY;
        return true;
      }}
      onResponderRelease={(event) => {
        if (from.current !== null && event.nativeEvent.pageY - from.current > PULL_TO_CLOSE) {
          onPulled();
        }
        from.current = null;
      }}
      style={{ paddingTop: top }}
      className="items-center border-b border-border px-4"
    >
      <Text numberOfLines={1} className="py-2 text-sm text-muted-foreground">
        {where === "" ? " " : where}
      </Text>
    </View>
  );
}

/** "Tab closed", whom it told, and Undo, while Undo can still bring it back. */
function UndoLine({
  closed,
  onUndo,
}: {
  readonly closed: Closed | null;
  readonly onUndo: () => void;
}) {
  const { i18n } = usePresentation();
  const { t, plural } = i18n;
  const bots = useBots();
  if (closed === null) return null;
  const told = closed.bots.filter((botId) => bots.has(botId));
  const text =
    told.length === 0
      ? t("browser.grid.closed")
      : plural("browser.grid.closedTold", told.length, {
          names: botNames(told, (botId) => bots.get(botId)?.profile.name ?? "", i18n),
        });
  return (
    <View
      accessibilityLiveRegion="polite"
      className="mx-3 mb-2 flex-row items-center gap-2 rounded-lg bg-foreground ps-4"
    >
      <Text className="min-w-0 flex-1 py-2.5 text-sm text-background">{text}</Text>
      <PressScale
        depth="control"
        accessibilityRole="button"
        onPress={onUndo}
        className="min-h-11 justify-center px-4"
      >
        <Text className="text-sm font-semibold text-background">{t("browser.grid.undo")}</Text>
      </PressScale>
    </View>
  );
}

/**
 * The bar in the thumb's reach: at the bottom, or down the side as the phone
 * lies on it. Swiped sideways, it goes to the next tab. While the keyboard is
 * up on a field of the page, it holds the previous and next field, the line,
 * and OK, which puts the keyboard away.
 */
function LiveBar({
  lying,
  use,
  frozen,
  faces,
  text,
  action,
  tabs,
  shown,
  needsYou,
  more,
  onClose,
  onBack,
  onSheet,
  onTabs,
  onMore,
  onStep,
  onField,
  onDoneTyping,
}: {
  readonly lying: boolean;
  readonly use: PageUseHandle;
  readonly frozen: Frozen;
  readonly faces: ReturnType<typeof tabFaces>;
  readonly text: string;
  readonly action: "now" | "continue" | null;
  readonly tabs: ReadonlyArray<ViewerTab>;
  readonly shown: BrowserTabRef | null;
  readonly needsYou: boolean;
  readonly more: RefObject<ComponentRef<typeof View> | null>;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onSheet: () => void;
  readonly onTabs: () => void;
  readonly onMore: () => void;
  readonly onStep: (direction: -1 | 1) => void;
  readonly onField: (direction: "next" | "previous") => void;
  readonly onDoneTyping: () => void;
}) {
  const { t, plural } = useI18n();
  const insets = useSafeAreaInsets();
  const swipe = useSideSwipe({
    onSwipe: (direction) => {
      if (direction !== null) onStep(direction);
    },
  });
  const live = frozen._tag === "live";
  const actionButton =
    action === null ? null : (
      <PressScale
        depth="control"
        accessibilityRole="button"
        onPress={use.giveBack}
        className="min-h-11 justify-center rounded-pill border border-input px-3"
      >
        <Text className="text-sm font-semibold text-foreground">
          {t(action === "now" ? "browser.line.now" : "browser.line.continue")}
        </Text>
      </PressScale>
    );
  const line = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text === "" ? t("browser.sheet.title") : text}
      accessibilityLiveRegion="polite"
      onPress={onSheet}
      className={`min-h-11 min-w-0 flex-row items-center gap-2 ${lying ? "justify-center" : "flex-1 px-1 py-1"}`}
    >
      <Faces faces={faces} />
      {!lying && <Text className="min-w-0 flex-1 text-sm text-foreground">{text}</Text>}
    </Pressable>
  );
  const index = tabs.findIndex((tab) => tab.ref === shown);
  const tabsButton = (
    <PressScale
      depth="round"
      accessibilityRole="button"
      accessibilityLabel={`${plural("browser.live.tabs", tabs.length)}${needsYou ? `, ${t("browser.live.needsYou")}` : ""}`}
      onPress={onTabs}
      className="size-11 items-center justify-center"
    >
      <View className="size-6 items-center justify-center rounded-md border-2 border-foreground">
        <Text className="text-2xs font-semibold text-foreground">{tabs.length}</Text>
      </View>
      {needsYou && <View className="absolute end-1.5 top-1.5 size-2.5 rounded-pill bg-waiting" />}
    </PressScale>
  );
  const button = (icon: typeof X, label: string, onPress: () => void, disabled = false) => (
    <PressScale
      depth="round"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`size-11 items-center justify-center ${disabled ? "opacity-50" : ""}`}
    >
      <Icon icon={icon} size={20} color="accent-foreground" />
    </PressScale>
  );
  const moreButton = (
    <View ref={more} collapsable={false}>
      {button(Ellipsis, t("browser.live.more"), onMore)}
    </View>
  );

  if (use.keyboardUp && live) {
    return (
      <View className="flex-row items-center gap-1 border-t border-border bg-surface px-2 py-1">
        {button(ChevronUp, t("browser.keys.previous"), () => onField("previous"))}
        {button(ChevronDown, t("browser.keys.next"), () => onField("next"))}
        <Text
          accessibilityLiveRegion="polite"
          className="min-w-0 flex-1 px-1.5 text-sm text-muted-foreground"
        >
          {text}
        </Text>
        <PressScale
          depth="control"
          accessibilityRole="button"
          onPress={onDoneTyping}
          className="min-h-11 justify-center rounded-pill px-4"
        >
          <Text className="text-sm font-semibold text-foreground">{t("browser.keys.done")}</Text>
        </PressScale>
      </View>
    );
  }

  if (lying) {
    return (
      <View
        {...swipe}
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom, paddingEnd: insets.right }}
        className="w-16 items-center justify-between border-s border-border py-2"
      >
        {button(ChevronDown, t("browser.live.close"), onClose)}
        {button(ChevronLeft, t("browser.live.back"), onBack, !live)}
        {line}
        {actionButton}
        {tabsButton}
        {moreButton}
      </View>
    );
  }

  // Upright, the line reads whole on a row of its own, over the controls, wrapping rather than cut short.
  const lined = text !== "" || faces.length > 0 || action !== null;
  return (
    <View
      {...swipe}
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
      className="border-t border-border pt-1"
    >
      {lined && (
        <View className="flex-row items-center gap-1 px-2">
          {line}
          {actionButton}
        </View>
      )}
      <View className="flex-row items-center gap-0.5 px-1">
        {button(ChevronDown, t("browser.live.close"), onClose)}
        {button(ChevronLeft, t("browser.live.back"), onBack, !live)}
        <View className="min-w-0 flex-1 flex-row justify-center">
          {tabs.length > 1 && index !== -1 && (
            <View
              accessibilityLabel={t("browser.live.tabOf", {
                index: String(index + 1),
                count: String(tabs.length),
              })}
              className="max-w-full shrink flex-row flex-wrap justify-center gap-1.5"
            >
              {tabs.map((each, at) => (
                <View
                  key={each.ref}
                  className={`size-1.5 rounded-pill ${at === index ? "bg-foreground" : "bg-border"}`}
                />
              ))}
            </View>
          )}
        </View>
        {tabsButton}
        {moreButton}
      </View>
    </View>
  );
}

/**
 * What stands in the page's place: the last picture, dimmed under a calm
 * card, while the page is frozen; else how the view is coming, or why it
 * ended.
 */
function InPlace({
  tab,
  loading,
  state,
  frozen,
  onShowHere,
}: {
  readonly tab: ViewerTab | null;
  readonly loading: boolean;
  readonly state: BrowserViewState | null;
  readonly frozen: Frozen;
  readonly onShowHere: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const picture = useLastPicture(tab?.ref ?? null);
  const time = picture === null ? null : clockTime(DateTime.makeUnsafe(picture.at), ctx);
  const message = (
    text: ReactNode,
    action?: { readonly label: string; readonly onPress: () => void },
  ) => (
    <View className="absolute inset-0 items-center justify-center gap-4 px-6">
      {text}
      {action !== undefined && <Button variant="outline" {...action} />}
    </View>
  );
  const still =
    picture === null ? null : (
      <Image
        source={{ uri: picture.uri }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
        className="absolute inset-0 opacity-40"
      />
    );
  if (frozen._tag === "parked" || frozen._tag === "you-offline") {
    const parked = frozen._tag === "parked";
    return (
      <>
        {still}
        {message(
          <View
            accessibilityLiveRegion="polite"
            className="w-full max-w-sm gap-1.5 rounded-xl border border-border bg-surface p-5"
            style={{ elevation: OVERLAY_ELEVATION }}
          >
            <Text accessibilityRole="header" className="text-base font-medium text-foreground">
              {t(parked ? "browser.frozen.parked.title" : "browser.frozen.youOffline.title")}
            </Text>
            {time !== null && (
              <Text className="text-sm text-muted-foreground">
                {t(parked ? "browser.frozen.parked.body" : "browser.frozen.youOffline.body", {
                  time,
                })}
              </Text>
            )}
          </View>,
        )}
      </>
    );
  }
  if (tab === null) {
    return loading ? (
      <View className="absolute inset-0 items-center justify-center">
        <Working />
      </View>
    ) : (
      message(<Body>{t("browser.noTab")}</Body>)
    );
  }
  switch (state?.status._tag) {
    case undefined:
    case "connecting":
    case "live":
    case "reconnecting":
    case "paused":
      return (
        <>
          {still}
          {/* Away, the page waits for its computer: the line says so, and nothing is coming. */}
          {frozen._tag !== "away" && (
            <View className="absolute inset-0 items-center justify-center">
              <Working />
            </View>
          )}
        </>
      );
    case "gone":
      return message(<Body>{t("browser.gone")}</Body>);
    case "setup-needed":
      return message(
        <View className="items-center gap-2">
          <Body>{t("browser.setupNeeded")}</Body>
          <DocsLink href={BROWSER_SETUP_DOCS} label={t("details.browser.howToFix")} />
        </View>,
      );
    case "replaced":
      return message(<Body>{t("browser.replaced")}</Body>, {
        label: t("browser.showHere"),
        onPress: onShowHere,
      });
    case "failed":
      return message(<Body>{t("browser.failed")}</Body>, {
        label: t("browser.retry"),
        onPress: onShowHere,
      });
  }
}
