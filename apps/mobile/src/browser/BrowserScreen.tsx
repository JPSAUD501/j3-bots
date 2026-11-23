// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewState, Readable } from "@j3-bots/client-runtime";
import { frontTab, siteOf } from "@j3-bots/client-runtime/presentation";
import {
  useBrowserTabs,
  useBrowserView,
  useJ3Client,
  useReadable,
} from "@j3-bots/client-runtime/react";
import type { BrowserController, BrowserTab, BrowserTabRef, EntryId } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import { usePreventRemove } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as ExpoNetwork from "expo-network";
import { Keyboard as KeyboardIcon, X } from "lucide-react-native";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { PixelRatio, Pressable, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { Working } from "../components/States.tsx";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation, Screens } from "../navigation.tsx";
import { Text } from "../text.tsx";
import { Body, Button } from "../ui.tsx";
import { PageDialog } from "./PageDialog.tsx";
import { PageView } from "./PageView.tsx";

type Props = NativeStackScreenProps<Screens, "browser">;

/** The JPEG quality asked for on a cellular network, where every picture costs. */
const CELLULAR_QUALITY = 55;

/**
 * The tab the viewer shows: the one it was opened on, else the bot's front
 * tab. A tab that appears and becomes the front tab while the viewer is open,
 * as a sign-in window a page opens does, is followed; so is the front tab
 * once the one shown has closed.
 */
function useShownTab(tabs: ReadonlyArray<BrowserTab> | null, opened: BrowserTabRef | undefined) {
  const [shown, setShown] = useState<BrowserTabRef | null>(opened ?? null);
  const known = useRef<ReadonlySet<BrowserTabRef> | null>(null);
  const front = tabs === null ? null : frontTab(tabs);
  useEffect(() => {
    if (tabs === null) return;
    const before = known.current;
    known.current = new Set(tabs.map((tab) => tab.ref));
    if (front === null) return;
    if (shown === null || (before !== null && !before.has(front.ref))) setShown(front.ref);
  }, [tabs, front, shown]);
  return {
    ref: shown,
    tab: tabs?.find((tab) => tab.ref === shown) ?? null,
    /** Whether the bot has another tab to show once the one shown closed; shows it if so. */
    showFront: (): boolean => {
      if (front === null || front.ref === shown) return false;
      setShown(front.ref);
      return true;
    },
  };
}

/**
 * The size of picture to ask for, read for each socket: the screen's width
 * and height in pixels, at a lower quality on a cellular network.
 */
function useViewSize() {
  const { width, height } = useWindowDimensions();
  const network = ExpoNetwork.useNetworkState();
  const size = useRef({ maxWidth: 0, maxHeight: 0, cellular: false });
  useLayoutEffect(() => {
    size.current = {
      maxWidth: PixelRatio.getPixelSizeForLayoutSize(width),
      maxHeight: PixelRatio.getPixelSizeForLayoutSize(height),
      cellular: network.type === ExpoNetwork.NetworkStateType.CELLULAR,
    };
  });
  return () => {
    const { maxWidth, maxHeight, cellular } = size.current;
    return cellular ? { maxWidth, maxHeight, quality: CELLULAR_QUALITY } : { maxWidth, maxHeight };
  };
}

const controllerLines = {
  bot: "browser.status.bot",
  you: "browser.status.you",
  "another-device": "browser.status.anotherDevice",
  nobody: "browser.status.nobody",
} as const satisfies Record<BrowserController, KeyWith>;

/** The status line: how the page is coming, else who acts on it. */
const statusLine = (state: BrowserViewState | null): KeyWith | null => {
  switch (state?.status._tag) {
    case undefined:
    case "connecting":
      return "browser.connecting";
    case "reconnecting":
    case "paused":
      return "browser.reconnecting";
    case "live":
      return state.control === null ? null : controllerLines[state.control.controller];
    case "gone":
    case "setup-needed":
    case "replaced":
    case "failed":
      return null;
  }
};

/** What the viewer says in place of the page once the view has ended, or while it opens. */
function InPlace({
  state,
  noTab,
  onShowHere,
}: {
  readonly state: BrowserViewState | null;
  readonly noTab: boolean;
  readonly onShowHere: () => void;
}) {
  const { t } = useI18n();
  const message = (
    text: string,
    action?: { readonly label: string; readonly onPress: () => void },
  ) => (
    <View className="absolute inset-0 items-center justify-center gap-4 px-6">
      <Body>{text}</Body>
      {action !== undefined && <Button variant="outline" {...action} />}
    </View>
  );
  if (noTab) return message(t("browser.noTab"));
  switch (state?.status._tag) {
    case undefined:
    case "connecting":
      return (
        <View className="absolute inset-0 items-center justify-center">
          <Working />
        </View>
      );
    case "gone":
      return message(t("browser.gone"));
    case "setup-needed":
      return message(
        t(
          state.status.need === "sandbox"
            ? "browser.setupNeeded.sandbox"
            : "browser.setupNeeded.libraries",
        ),
      );
    case "replaced":
      return message(t("browser.replaced"), { label: t("browser.showHere"), onPress: onShowHere });
    case "failed":
      return message(t("browser.failed"), { label: t("browser.retry"), onPress: onShowHere });
    case "live":
    case "reconnecting":
    case "paused":
      return null;
  }
}

/**
 * A bot's browser on the whole screen: the page fitted to the width, a line
 * saying who acts on it, and Take control at the bottom. In control, the page
 * takes taps, drags and the keyboard, and the bottom bar holds Done, with
 * Can't do it beside it when a help card opened the viewer. Leaving while in
 * control asks whether to give the tab back.
 */
export function BrowserScreen({ navigation, route }: Props) {
  const { botId, help } = route.params;
  const tabs = useBrowserTabs(botId);
  const listed = tabs?._tag === "ready" ? tabs.value : null;
  const shown = useShownTab(listed, route.params.ref);
  // Showing the page again, after another window took it or it failed to open, is a view of its own.
  const [attempt, setAttempt] = useState(0);
  return (
    <TabViewer
      key={`${shown.ref ?? ""}:${attempt}`}
      navigation={navigation}
      tabRef={shown.ref}
      tab={shown.tab}
      help={help}
      noTab={listed !== null && listed.length === 0 && shown.ref === null}
      showFront={shown.showFront}
      onShowHere={() => setAttempt((n) => n + 1)}
    />
  );
}

function TabViewer({
  navigation,
  tabRef,
  tab,
  help,
  noTab,
  showFront,
  onShowHere,
}: {
  readonly navigation: Navigation;
  readonly tabRef: BrowserTabRef | null;
  readonly tab: BrowserTab | null;
  /** The help card the viewer was opened from, which Done and Can't do it answer. */
  readonly help: EntryId | undefined;
  readonly noTab: boolean;
  readonly showFront: () => boolean;
  readonly onShowHere: () => void;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const insets = useSafeAreaInsets();
  const view = useBrowserView(tabRef, useViewSize());
  const source: Readable<BrowserViewState | null> = view?.state ?? IDLE;
  const state = useReadable(source);

  const status = state?.status._tag;
  const controller = state?.control?.controller ?? null;
  const holding =
    controller === "you" && (status === "live" || status === "reconnecting" || status === "paused");
  const inControl = holding && status === "live";
  const site = siteOf(tab?.url ?? "");
  /** The page's site, or its title when it has none, as a local file does not. */
  const where = site === "" ? (tab?.title ?? "") : site;

  // A page that closed gives way to the bot's front tab, as one a help card names after a restart.
  const followFront = useEffectEvent(() => showFront());
  useEffect(() => {
    if (status === "gone") followFront();
  }, [status]);

  const leaving = useRef(false);
  const confirm = useConfirm();
  usePreventRemove(holding, ({ data }) => {
    if (leaving.current) {
      navigation.dispatch(data.action);
      return;
    }
    confirm({
      title: t("browser.handBack.title"),
      body: t("browser.handBack.body"),
      cancel: t("browser.handBack.keep"),
      confirm: t("browser.handBack.confirm"),
      reversible: true,
      onConfirm: () => {
        view?.send({ type: "release" });
        navigation.dispatch(data.action);
      },
    });
  });

  /** Gives the tab back, answers the help card that opened the viewer, and returns to the conversation. */
  const finish = (outcome: "done" | "declined") => {
    view?.send({ type: "release" });
    if (help !== undefined) void client.answerCard(help, { _tag: "browser-help", outcome });
    leaving.current = true;
    navigation.goBack();
  };

  const [keyboardRequests, setKeyboardRequests] = useState(0);
  const line = statusLine(state);
  const dialog = inControl ? (state?.control?.dialog ?? null) : null;
  const showsPage =
    view !== null && (status === "live" || status === "reconnecting" || status === "paused");

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <View style={{ paddingTop: insets.top }} className="border-b border-border">
        <View className="min-h-14 flex-row items-center gap-1 px-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("browser.close")}
            onPress={() => navigation.goBack()}
            className="size-11 items-center justify-center"
          >
            <Icon icon={X} size={20} color="accent-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1 px-1.5">
            <Text numberOfLines={1} className="text-base font-medium text-foreground">
              {where}
            </Text>
            <Text
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              className={`text-2xs ${controller === "you" ? "text-accent" : "text-muted-foreground"}`}
            >
              {line === null ? " " : t(line)}
            </Text>
          </View>
        </View>
      </View>

      <View className="flex-1">
        {showsPage && (
          <PageView
            view={view}
            page={state?.viewport ?? null}
            interactive={inControl}
            keyboardRequests={keyboardRequests}
            label={t("browser.page", { site: where })}
          />
        )}
        <InPlace state={state} noTab={noTab} onShowHere={onShowHere} />
        {dialog !== null && view !== null && (
          <PageDialog
            // Each dialog the page opens starts with its own default value.
            key={`${dialog.kind}:${dialog.message}:${dialog.defaultValue}`}
            dialog={dialog}
            site={where}
            onAnswer={(answer) => view.send(answer)}
          />
        )}
      </View>

      <View
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        className="flex-row items-center gap-2 border-t border-border px-4 pt-3"
      >
        {holding ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("browser.keyboard")}
              accessibilityState={{ disabled: !inControl }}
              disabled={!inControl}
              onPress={() => setKeyboardRequests((n) => n + 1)}
              className={`size-11 items-center justify-center rounded-pill border border-input ${inControl ? "" : "opacity-50"}`}
            >
              <Icon icon={KeyboardIcon} size={18} color="accent-foreground" />
            </Pressable>
            {help !== undefined && (
              <Button
                label={t("browser.cantDoIt")}
                variant="secondary"
                grow
                onPress={() => finish("declined")}
              />
            )}
            <Button
              label={t("browser.done")}
              variant="primary"
              grow
              onPress={() => finish("done")}
            />
          </>
        ) : (
          <Button
            label={t("browser.take")}
            variant="primary"
            grow
            disabled={status !== "live" || controller === "another-device"}
            onPress={() => view?.send({ type: "take" })}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** What a viewer with no view yet reads. */
const IDLE: Readable<null> = { get: () => null, subscribe: () => () => undefined };
