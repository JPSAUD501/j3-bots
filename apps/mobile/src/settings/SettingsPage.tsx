// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsPage } from "@j3-bots/client-runtime/presentation";
import {
  useConnection,
  useEngineStatus,
  useJ3Client,
  useRecentTurns,
} from "@j3-bots/client-runtime/react";
import { settingsPageWords } from "@j3-bots/client-runtime/wording";
import { layout } from "@j3-bots/design-tokens";
import { type RouteProp, useFocusEffect, useIsFocused, useRoute } from "@react-navigation/native";
import { useCallback } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectorsSection } from "../connectors/ConnectorsSection.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { SecretsSection } from "../secrets/SecretsSection.tsx";
import { Text } from "../text.tsx";
import { AboutSection } from "./About.tsx";
import { BrowserSection } from "./BrowserSettings.tsx";
import { DevicesSection } from "./Devices.tsx";
import { usePhoneNotifications } from "./phoneNotifications.ts";
import { NotificationsSection, YouSection } from "./Profile.tsx";
import { ProvidersSection } from "./Providers.tsx";
import { AppearanceSection, ServerSection, SignOutSection } from "./ThisPhone.tsx";
import { UsageSection } from "./Usage.tsx";
import { VoiceSection } from "./Voice.tsx";

/**
 * One page of Settings, named in the header, with the line that says what it
 * holds over its groups. Coming to it reads the settings and the devices
 * again, as the list does, for a page opened straight from the roster's
 * update notice.
 */
export function SettingsPageScreen() {
  const client = useJ3Client();
  const insets = useSafeAreaInsets();
  const { page } = useRoute<RouteProp<Screens, "settingsPage">>().params;
  const { description } = settingsPageWords(page, useI18n());
  useFocusEffect(
    useCallback(() => {
      client.refreshSettings();
      client.refreshDevices();
    }, [client]),
  );
  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        width: "100%",
        maxWidth: layout.textColumn,
        alignSelf: "center",
        paddingBottom: insets.bottom + 24,
      }}
    >
      <View className="px-5 pt-4">
        <Text className="text-sm text-muted-foreground">{description}</Text>
      </View>
      <PageBody page={page} />
    </ScrollView>
  );
}

/** What one page holds. */
function PageBody({ page }: { readonly page: SettingsPage }) {
  const connected = useConnection()._tag === "connected";
  switch (page) {
    case "you":
      return <YouSection connected={connected} />;
    case "notifications":
      return <NotificationsPage connected={connected} />;
    case "appearance":
      return <AppearanceSection />;
    case "voice":
      return <VoiceSection connected={connected} />;
    case "providers":
      return <ProvidersSection />;
    case "usage":
      return <UsagePage />;
    case "connectors":
      return <ConnectorsSection />;
    case "secrets":
      return <SecretsSection />;
    case "browser":
      return <BrowserSection connected={connected} />;
    case "devices":
      return (
        <>
          <DevicesSection connected={connected} />
          <SignOutSection />
        </>
      );
    case "where":
      return <ServerSection />;
    case "updates":
      return <AboutSection connected={connected} />;
  }
}

/** The notifications, with this phone's own permission. */
function NotificationsPage({ connected }: { readonly connected: boolean }) {
  return <NotificationsSection connected={connected} thisPhone={usePhoneNotifications()} />;
}

/** What each provider allows and who spends it; the turns are read while the page is in front. */
function UsagePage() {
  const status = useEngineStatus();
  const recent = useRecentTurns(useIsFocused());
  return (
    <UsageSection
      engine={status._tag === "ready" ? status.value : null}
      engineStale={status._tag === "ready" && status.stale}
      recent={recent.state}
      onLoadMore={recent.loadMore}
      onRetry={recent.retry}
    />
  );
}
