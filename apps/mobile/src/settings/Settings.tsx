// SPDX-License-Identifier: AGPL-3.0-or-later
import { isRunning } from "@j3-bots/client-runtime";
import {
  connectorNeedsYou,
  providersNeedYou,
  type SettingsPage,
  settingsGroups,
} from "@j3-bots/client-runtime/presentation";
import {
  useConnectors,
  useEngineStatus,
  useJ3Client,
  useServerUpdate,
  useSettings,
} from "@j3-bots/client-runtime/react";
import { settingsPageWords } from "@j3-bots/client-runtime/wording";
import { layout } from "@j3-bots/design-tokens";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  Bell,
  ChevronRight,
  Cpu,
  Gauge,
  KeyRound,
  type LucideIcon,
  Mic,
  MonitorSmartphone,
  Palette,
  Plug,
  RefreshCw,
  Server,
  UserRound,
} from "lucide-react-native";
import { useCallback } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { usePhoneRecognizer } from "../platform/dictation.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { WhatsNewRow } from "../update/WhatsNew.tsx";

const pageIcons: Record<SettingsPage, LucideIcon> = {
  you: UserRound,
  notifications: Bell,
  appearance: Palette,
  voice: Mic,
  providers: Cpu,
  usage: Gauge,
  connectors: Plug,
  secrets: KeyRound,
  devices: MonitorSmartphone,
  where: Server,
  updates: RefreshCw,
};

/**
 * Everything that is not about one bot, as a list of its pages, each opening
 * on its own screen. Coming to it reads the settings and the devices again,
 * for what another device changed. A page that waits on the operator carries
 * a dot: the engine or no provider able to run a bot, a connector that needs
 * them, or a server update on offer. Voice is listed while the server keeps
 * dictation's settings, or, facing a server older than dictation through it,
 * while this phone dictates by itself. What's new ends the list. On a wide
 * screen it keeps to the conversation's text column.
 */
export function SettingsScreen() {
  const client = useJ3Client();
  const insets = useSafeAreaInsets();
  const status = useEngineStatus();
  const connectors = useConnectors();
  const update = useServerUpdate();
  const settings = useSettings();
  const voice = settings._tag === "ready" ? settings.value.voice : null;
  const phone = usePhoneRecognizer(voice?.language ?? "auto");
  const listed = (page: SettingsPage): boolean =>
    page !== "voice" || voice !== null || phone?.state === "ready";
  useFocusEffect(
    useCallback(() => {
      client.refreshSettings();
      client.refreshDevices();
    }, [client]),
  );
  const needsYou = (page: SettingsPage): boolean => {
    switch (page) {
      case "providers":
        return status._tag === "ready" && !status.stale && providersNeedYou(status.value);
      case "connectors":
        return connectors._tag === "ready" && connectors.value.some(connectorNeedsYou);
      case "updates":
        return (
          update._tag === "status" &&
          update.status.available !== null &&
          update.status.canUpdate._tag === "able" &&
          !isRunning(update.status.state)
        );
      default:
        return false;
    }
  };
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        width: "100%",
        maxWidth: layout.textColumn,
        alignSelf: "center",
        gap: 24,
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: insets.bottom + 16,
      }}
    >
      {settingsGroups.map((group) => (
        <View key={group[0]} className="gap-0.5">
          {group.filter(listed).map((page) => (
            <PageRow key={page} page={page} needsYou={needsYou(page)} />
          ))}
        </View>
      ))}
      <WhatsNewRow />
    </ScrollView>
  );
}

/** A page's row: its icon and name, a dot while it waits on the operator, and the way in. */
function PageRow({ page, needsYou }: { readonly page: SettingsPage; readonly needsYou: boolean }) {
  const i18n = useI18n();
  const navigation = useNavigation<Navigation>();
  const { title } = settingsPageWords(page, i18n);
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={needsYou ? `${title}, ${i18n.t("settings.needsYou")}` : title}
      onPress={() => navigation.push("settingsPage", { page })}
      className="min-h-12 flex-row items-center gap-3 rounded-lg px-3 active:bg-muted"
    >
      <Icon icon={pageIcons[page]} size={20} color="accent-muted-foreground" />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
        {title}
      </Text>
      {needsYou && <View className="size-2 rounded-pill bg-accent" />}
      <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
    </PressScale>
  );
}
