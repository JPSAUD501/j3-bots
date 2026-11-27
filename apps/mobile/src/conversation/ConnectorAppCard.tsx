// SPDX-License-Identifier: AGPL-3.0-or-later
import { Cell, type Readable } from "@j3-bots/client-runtime";
import {
  type ConnectorAppDisplayMode,
  connectorAppStartHeight,
  MAX_CONNECTOR_APP_PIP_HEIGHT,
} from "@j3-bots/client-runtime/presentation";
import { useReadable } from "@j3-bots/client-runtime/react";
import type { ConnectorAppRef, MessageEntry } from "@j3-bots/contracts";
import { springs } from "@j3-bots/design-tokens";
import { type LucideIcon, Maximize2, X } from "lucide-react-native";
import { use, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { ConnectorTile } from "../connectors/parts.tsx";
import { useI18n } from "../i18n.ts";
import { settleIn } from "../motion.ts";
import { useBots } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { Button } from "../ui.tsx";
import { AnimatedView } from "./animated.ts";
import {
  type AppAsk,
  type LiveApp,
  type LiveAppState,
  type StagedApp,
  useAppStage,
} from "./AppStage.tsx";
import { NativeAppFrame } from "./appFrames.ts";
import { MessageText } from "./MessageText.tsx";
import { EntryWidths } from "./widths.ts";

// A connector's app on Android: the interface a connector's server gave the
// tool a bot called, part of the bot's reply where the call happened
// (decision 0093), in the app's own isolated frame (`appFrames.ts`, and
// `modules/connector-app-view`), inside `connectorAppShell`'s sandboxed
// page. It can go full screen over the conversation or pin to its top, in
// the same frame, which moves there without loading again.
// docs/architecture/security.md, "Connector apps", says what it can and
// cannot reach; docs/architecture/clients.md says how a client draws one.

/** How far a pinned app sits from the conversation's top and sides, and how wide it gets, in dp. */
const PIN_MARGIN = 8;
const PIN_WIDTH = 560;

/** The app of `app`, running while the caller is mounted, and a while after; null until it is. */
function useHeldApp(app: ConnectorAppRef): LiveApp | null {
  const { hold, lives } = useAppStage();
  const running = useReadable(lives);
  useEffect(() => hold(app), [hold, app]);
  return running.get(app.viewId) ?? null;
}

/** What `live` shows now: before it runs, an app that opens at the height it last had. */
function useLiveState(live: LiveApp | null, app: ConnectorAppRef): LiveAppState {
  const opening = useMemo<Readable<LiveAppState>>(
    () =>
      new Cell<LiveAppState>({
        page: null,
        failed: false,
        height: connectorAppStartHeight(app.viewId),
        modes: [],
        asks: [],
      }),
    [app.viewId],
  );
  return useReadable(live?.state ?? opening);
}

/**
 * One app in the bot's reply: a light header with its connector and its tool,
 * and its frame, which follows the app's height within bounds. Shown full
 * screen or pinned, its place in the reply keeps its height and says where
 * it is.
 */
export function ConnectorAppBlock({ app }: { readonly app: ConnectorAppRef }) {
  const { t } = useI18n();
  const { staged, show } = useAppStage();
  const widths = use(EntryWidths);
  const live = useHeldApp(app);
  const state = useLiveState(live, app);
  const mode: ConnectorAppDisplayMode = staged?.app.viewId === app.viewId ? staged.mode : "inline";
  const canExpand = state.modes.includes("fullscreen") && mode !== "fullscreen";

  return (
    <View
      style={{ width: widths.card }}
      className="my-1 self-start overflow-hidden rounded-bubble border border-border bg-surface"
    >
      <AppHeader
        app={app}
        {...(canExpand ? { onExpand: () => void show(app.viewId, "fullscreen") } : {})}
      />
      {state.failed ? (
        <Text className="px-4 py-6 text-center text-sm text-muted-foreground">
          {t("connectorApp.failed")}
        </Text>
      ) : mode !== "inline" ? (
        <View style={{ height: state.height }} className="items-center justify-center gap-2 px-4">
          <Text className="text-center text-sm text-muted-foreground">
            {mode === "fullscreen" ? t("connectorApp.shownFull") : t("connectorApp.shownPinned")}
          </Text>
          <Button
            label={t("connectorApp.backToReply")}
            onPress={() => void show(app.viewId, "inline")}
          />
        </View>
      ) : live === null || state.page === null ? (
        <View style={{ height: state.height }} />
      ) : (
        <AppFrame
          live={live}
          page={state.page}
          mode="inline"
          height={state.height}
          asks={state.asks}
        />
      )}
    </View>
  );
}

/**
 * The app shown other than in the reply, over the conversation's list: full
 * screen, between the conversation's header and its composer, with the
 * bot's new reply over its lower part; or pinned at the top while the
 * conversation scrolls under it.
 */
export function StagedConnectorApp({ bottom }: { readonly bottom: number }) {
  const { staged } = useAppStage();
  if (staged === null) return null;
  return staged.mode === "fullscreen" ? (
    <View
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom }}
      className="bg-background"
    >
      <FullScreenApp key={staged.app.viewId} staged={staged} />
    </View>
  ) : (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: PIN_MARGIN, left: PIN_MARGIN, right: PIN_MARGIN }}
      className="items-center"
    >
      <PinnedApp key={staged.app.viewId} staged={staged} />
    </View>
  );
}

function FullScreenApp({ staged }: { readonly staged: StagedApp }) {
  const { t } = useI18n();
  const { show, replies } = useAppStage();
  const { app } = staged;
  const live = useHeldApp(app);
  const state = useLiveState(live, app);
  return (
    <AnimatedView
      entering={settleIn(springs.soft)}
      className="flex-1"
      accessibilityLabel={t("connectorApp.title", { tool: app.tool, connector: app.connector })}
    >
      <AppHeader app={app} onClose={() => void show(app.viewId, "inline")} />
      {live !== null && state.page !== null ? (
        <AppFrame live={live} page={state.page} mode="fullscreen" height={null} asks={state.asks} />
      ) : (
        <View className="flex-1" />
      )}
      <ReplySheet replies={replies} />
    </AnimatedView>
  );
}

function PinnedApp({ staged }: { readonly staged: StagedApp }) {
  const { show } = useAppStage();
  const { app } = staged;
  const live = useHeldApp(app);
  const state = useLiveState(live, app);
  return (
    <AnimatedView
      entering={settleIn(springs.soft)}
      style={{ width: "100%", maxWidth: PIN_WIDTH, elevation: OVERLAY_ELEVATION }}
      className="overflow-hidden rounded-bubble border border-border bg-surface"
    >
      <AppHeader
        app={app}
        {...(state.modes.includes("fullscreen")
          ? { onExpand: () => void show(app.viewId, "fullscreen") }
          : {})}
        onClose={() => void show(app.viewId, "inline")}
      />
      {live !== null && state.page !== null ? (
        <AppFrame
          live={live}
          page={state.page}
          mode="pip"
          height={Math.min(state.height, MAX_CONNECTOR_APP_PIP_HEIGHT)}
          asks={state.asks}
        />
      ) : (
        <View style={{ height: Math.min(state.height, MAX_CONNECTOR_APP_PIP_HEIGHT) }} />
      )}
    </AnimatedView>
  );
}

/** Whose app it is: its connector's mark and name, the tool, and what the operator can do with it. */
function AppHeader({
  app,
  onExpand,
  onClose,
}: {
  readonly app: ConnectorAppRef;
  readonly onExpand?: () => void;
  readonly onClose?: () => void;
}) {
  const { t } = useI18n();
  return (
    <View className="min-h-11 flex-row items-center gap-2 border-b border-border pl-2.5">
      <ConnectorTile name={app.connector} glyph={app.glyph} size="sm" />
      <Text numberOfLines={1} className="flex-1 text-xs text-muted-foreground">
        <Text className="text-xs font-medium text-foreground">{app.connector}</Text>
        {` · ${app.tool}`}
      </Text>
      {onExpand !== undefined && (
        <HeaderButton
          icon={Maximize2}
          label={t("connectorApp.expand", { tool: app.tool })}
          onPress={onExpand}
        />
      )}
      {onClose !== undefined && (
        <HeaderButton
          icon={X}
          label={t("connectorApp.close", { tool: app.tool })}
          onPress={onClose}
        />
      )}
    </View>
  );
}

function HeaderButton({
  icon,
  label,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="size-11 items-center justify-center"
    >
      <Icon icon={icon} size={18} color="accent-muted-foreground" />
    </Pressable>
  );
}

/**
 * The app's frame and what it asked of the operator. Wherever it is drawn,
 * the frame is the app's one (`NativeAppFrame` with its key), which moves
 * here without loading again; the app is told the size it has here.
 */
function AppFrame({
  live,
  page,
  mode,
  height,
  asks,
}: {
  readonly live: LiveApp;
  readonly page: string;
  readonly mode: ConnectorAppDisplayMode;
  /** Null: it fills what it is in. */
  readonly height: number | null;
  readonly asks: ReadonlyArray<AppAsk>;
}) {
  const { t } = useI18n();
  const { app } = live;
  if (NativeAppFrame === null) return null;
  return (
    <>
      <View
        style={height === null ? { flex: 1 } : { height }}
        onLayout={({ nativeEvent: { layout } }) =>
          live.placed(mode, { width: layout.width, height: layout.height })
        }
        accessibilityLabel={t("connectorApp.title", { tool: app.tool, connector: app.connector })}
      >
        <NativeAppFrame appKey={live.key} document={page} style={{ flex: 1 }} />
      </View>
      {asks.map((ask) => (
        <AskLine key={ask.id} ask={ask} connector={app.connector} />
      ))}
    </>
  );
}

/**
 * What the bots said since the app went full screen, over its lower part and
 * riding up with the composer, so the operator reads it without closing the
 * app. Hidden until the next.
 */
function ReplySheet({ replies }: { readonly replies: ReadonlyArray<MessageEntry> }) {
  const { t } = useI18n();
  const bots = useBots();
  const insets = useSafeAreaInsets();
  const latest = replies.at(-1) ?? null;
  const [hidden, setHidden] = useState<string | null>(null);
  if (latest === null || hidden === latest.id) return null;
  const name =
    latest.author._tag === "bot"
      ? (bots.get(latest.author.botId)?.profile.name ?? t("bot.unknown"))
      : null;
  return (
    <KeyboardStickyView
      offset={{ closed: 0, opened: insets.bottom }}
      style={{ position: "absolute", left: 12, right: 12, bottom: 12 }}
      pointerEvents="box-none"
    >
      <AnimatedView
        key={latest.id}
        entering={settleIn(springs.slide)}
        accessibilityLiveRegion="polite"
        style={{ elevation: OVERLAY_ELEVATION }}
        className="max-h-60 gap-1 rounded-bubble border border-border bg-surface p-3"
      >
        <View className="flex-row items-center gap-2">
          {name !== null && (
            <Text numberOfLines={1} className="flex-1 text-xs font-medium text-foreground">
              {name}
            </Text>
          )}
          <Button
            label={t("connectorApp.hideReply")}
            variant="quiet"
            onPress={() => setHidden(latest.id)}
          />
        </View>
        <ScrollView>
          <MessageText text={latest.text} mentionable={[]} className="text-foreground" />
        </ScrollView>
      </AnimatedView>
    </KeyboardStickyView>
  );
}

/** What the app asked of the operator, and the buttons that answer it. The app cannot reach this line. */
function AskLine({ ask, connector }: { readonly ask: AppAsk; readonly connector: string }) {
  const { t } = useI18n();
  const line = (text: string, yes: string, no: string, answer: (yes: boolean) => void) => (
    <View className="gap-2 border-t border-border px-3 py-2.5">
      <Text className="text-sm text-foreground">{text}</Text>
      <View className="flex-row justify-end gap-2">
        <Button label={no} variant="plain" onPress={() => answer(false)} />
        <Button label={yes} variant="primary" onPress={() => answer(true)} />
      </View>
    </View>
  );
  switch (ask._tag) {
    case "call":
      return line(
        t("connectorApp.askCall", { tool: ask.tool, connector }),
        t("connectorApp.allow"),
        t("connectorApp.deny"),
        (yes) => ask.done(yes ? "allowed" : "declined"),
      );
    case "message":
      return line(
        t("connectorApp.askMessage", { text: ask.text }),
        t("connectorApp.send"),
        t("connectorApp.dismiss"),
        (yes) => ask.done(yes),
      );
    case "link":
      return line(
        t("connectorApp.askLink", { url: ask.url.href }),
        t("connectorApp.open"),
        t("connectorApp.dismiss"),
        (yes) => ask.done(yes),
      );
    case "download":
      return line(
        t("connectorApp.askDownload", { names: ask.names.join(", ") }),
        t("connectorApp.save"),
        t("connectorApp.dismiss"),
        (yes) => ask.done(yes),
      );
  }
}
