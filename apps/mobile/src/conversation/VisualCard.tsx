// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId, Visual } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { Maximize2, X } from "lucide-react-native";
import { use, useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { canShowVisuals, type VisualFailure, VisualFrame } from "./VisualFrame.tsx";
import { type ConversationVisuals, ConversationVisualsContext } from "./visuals.ts";
import { EntryWidths } from "./widths.ts";

const notMoving = () => false;
const noSubscription = () => () => undefined;

/** Where a visual starts when neither the bot nor the page has said how tall it is. */
const UNMEASURED_HEIGHT = 240;

/**
 * How long a visual waits, once its row is drawn and the list is still,
 * before its page loads: a row that only passes by in a fling stays a
 * placeholder and never starts a WebView. The list draws only rows near the
 * screen, so at most those load. Once loaded, it stays while its row does.
 */
const SETTLE_MS = 150;

/** Whether the row has stayed drawn, with the list still, for `SETTLE_MS`. */
function useSettled(visuals: ConversationVisuals | null): boolean {
  const moving = useSyncExternalStore(
    visuals?.subscribe ?? noSubscription,
    visuals?.moving ?? notMoving,
  );
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled || moving) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled, moving]);
  return settled;
}

type Shown = "loading" | "shown" | "failed";

/**
 * The page a bot's message `id` showed above its words, drawn in the
 * conversation at the height it reports (clamped to the contract's range), in
 * the app's current theme. It is only
 * drawn there: a press opens it full screen, where the operator can touch,
 * scroll and zoom it. Until it has painted, its title holds its place; one
 * that cannot be drawn says so in a line, under its title.
 */
export function VisualCard({ id, visual }: { readonly id: EntryId; readonly visual: Visual }) {
  const { t } = useI18n();
  const widths = use(EntryWidths);
  const visuals = use(ConversationVisualsContext);
  const settled = useSettled(visuals);
  const [height, setHeight] = useState(
    () => visuals?.heights.get(id) ?? visual.height ?? UNMEASURED_HEIGHT,
  );
  const [shown, setShown] = useState<Shown>(() =>
    canShowVisuals && visuals?.failed.has(id) !== true ? "loading" : "failed",
  );
  const [open, setOpen] = useState(false);
  const full = widths.column < layout.breakpoints.tablet;
  const failed = shown === "failed";
  const fail = (failure: VisualFailure) => {
    if (failure === "page") visuals?.failed.add(id);
    setShown("failed");
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={visual.title}
        accessibilityHint={failed ? t("visual.failed") : t("visual.open")}
        accessibilityState={{ busy: shown === "loading", disabled: failed }}
        onPress={failed ? undefined : () => setOpen(true)}
        style={full ? undefined : { width: widths.card }}
        className={`overflow-hidden rounded-bubble border border-border bg-surface ${full ? "self-stretch" : "self-start"}`}
      >
        {failed ? (
          <View className="gap-0.5 px-3.5 py-3">
            <Text numberOfLines={2} className="text-sm font-medium text-foreground">
              {visual.title}
            </Text>
            <Text className="text-xs text-muted-foreground">{t("visual.failed")}</Text>
          </View>
        ) : (
          <View style={{ height }}>
            {shown === "loading" && (
              <View className="absolute inset-0 items-center justify-center px-4">
                <Text numberOfLines={2} className="text-center text-sm text-muted-foreground">
                  {visual.title}
                </Text>
              </View>
            )}
            {settled && (
              // Only drawn here: touches go to the card, and a screen reader reads its title.
              <View
                pointerEvents="none"
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
                className="flex-1"
              >
                <VisualFrame
                  html={visual.html}
                  interactive={false}
                  onHeight={(reported) => {
                    visuals?.heights.set(id, reported);
                    setHeight(reported);
                  }}
                  onLoaded={() => setShown("shown")}
                  onFailed={fail}
                  style={{ flex: 1 }}
                />
              </View>
            )}
            {shown === "shown" && (
              <View className="absolute end-2 top-2 size-7 items-center justify-center rounded-md bg-background/80">
                <Icon icon={Maximize2} size={14} color="accent-muted-foreground" />
              </View>
            )}
          </View>
        )}
      </Pressable>
      {open && <VisualFullScreen visual={visual} onFailed={fail} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * A visual over the whole screen, in the same isolated view, now one the
 * operator can touch, scroll and pinch to zoom. Its title heads it; the close
 * button, and Back, close it.
 */
function VisualFullScreen({
  visual,
  onFailed,
  onClose,
}: {
  readonly visual: Visual;
  /** Told as the card is: a page that fails here fails inline too. */
  readonly onFailed: (failure: VisualFailure) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [failed, setFailed] = useState(false);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 bg-surface">
        <View
          className="flex-row items-center gap-2 border-b border-border bg-background pe-1 ps-4"
          style={{ paddingTop: insets.top }}
        >
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            className="flex-1 text-base font-medium text-foreground"
          >
            {visual.title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("visual.close")}
            onPress={onClose}
            className="size-12 items-center justify-center"
          >
            <Icon icon={X} size={20} color="accent-foreground" />
          </Pressable>
        </View>
        <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
          {failed ? (
            <View className="flex-1 items-center justify-center px-6">
              <Text className="text-center text-sm text-muted-foreground">
                {t("visual.failed")}
              </Text>
            </View>
          ) : (
            <VisualFrame
              html={visual.html}
              interactive
              onFailed={(failure) => {
                setFailed(true);
                onFailed(failure);
              }}
              style={{ flex: 1 }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}
