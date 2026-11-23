// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  useConnection,
  useEngineStatus,
  useJ3Client,
  useRecentTurns,
} from "@j3-bots/client-runtime/react";
import { connectCommand } from "@j3-bots/client-runtime/presentation";
import { engineProblem } from "@j3-bots/client-runtime/wording";
import type { EngineStatus } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { type RouteProp, useFocusEffect, useIsFocused, useRoute } from "@react-navigation/native";
import { type ComponentRef, useCallback, useRef } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectCommand, ProviderRow } from "../components/Engine.tsx";
import { Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { AboutSection } from "./About.tsx";
import { DevicesSection } from "./Devices.tsx";
import { usePhoneNotifications } from "./phoneNotifications.ts";
import { NotificationsSection, YouSection } from "./Profile.tsx";
import { ServerSection, ThisPhoneSection } from "./ThisPhone.tsx";
import { UsageSection } from "./Usage.tsx";

/**
 * Everything that is not about one bot. Coming to it reads the settings and
 * the devices again, for what another device changed, and the turns bots
 * spent are read while it is in front. On a wide screen it keeps to the
 * conversation's text column.
 */
export function SettingsScreen() {
  const client = useJ3Client();
  const insets = useSafeAreaInsets();
  const status = useEngineStatus();
  const engine = status._tag === "ready" ? status.value : null;
  const engineStale = status._tag === "ready" && status.stale;
  const connected = useConnection()._tag === "connected";
  const recent = useRecentTurns(useIsFocused());
  const thisPhone = usePhoneNotifications();
  const section = useRoute<RouteProp<Screens, "settings">>().params?.section;
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Opened for the updates, Settings starts at them, once they are laid out.
  const scrolled = useRef(false);
  const onUpdatesLaidOut = (y: number) => {
    if (section !== "updates" || scrolled.current) return;
    scrolled.current = true;
    scroll.current?.scrollTo({ y, animated: false });
  };
  useFocusEffect(
    useCallback(() => {
      client.refreshSettings();
      client.refreshDevices();
    }, [client]),
  );
  return (
    <ScrollView
      ref={scroll}
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        width: "100%",
        maxWidth: layout.textColumn,
        alignSelf: "center",
        paddingBottom: insets.bottom + 16,
      }}
    >
      {/* The operator's own settings first, then the engine and what it spent, as on the web. */}
      <YouSection connected={connected} />
      <NotificationsSection connected={connected} thisPhone={thisPhone} />
      <EngineSection engine={engine} stale={engineStale} />
      <UsageSection
        engine={engine}
        engineStale={engineStale}
        recent={recent.state}
        onLoadMore={recent.loadMore}
        onRetry={recent.retry}
      />
      <DevicesSection connected={connected} />
      <ServerSection />
      <AboutSection onLayout={onUpdatesLaidOut} />
      <ThisPhoneSection />
    </ScrollView>
  );
}

/**
 * Whether the engine runs, and if not, why and what to do; then each provider.
 * Disconnected, it is what the server last reported, muted and said to be so.
 */
function EngineSection(props: { readonly engine: EngineStatus | null; readonly stale: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { engine, stale } = props;
  if (engine === null) {
    return (
      <Section title={t("settings.engine")}>
        <SkeletonRows />
      </Section>
    );
  }
  const problem = engineProblem(engine, i18n);
  const connect = connectCommand(engine);
  return (
    <Section title={t("settings.engine")}>
      {stale && <Quiet>{t("settings.engine.lastKnown")}</Quiet>}
      {problem === null ? (
        <Text className={`text-sm ${stale ? "text-muted-foreground" : "text-foreground"}`}>
          {t("settings.engine.ready", { version: engine.pinnedVersion })}
        </Text>
      ) : (
        <View className="gap-1">
          {/* Starting, or downloading, is on its way rather than blocked. */}
          <Text
            className={`text-sm font-medium tabular-nums ${
              stale
                ? "text-muted-foreground"
                : engine.state._tag === "starting"
                  ? "text-foreground"
                  : "text-blocked"
            }`}
          >
            {problem.title}
          </Text>
          <Quiet>{problem.body}</Quiet>
        </View>
      )}
      {engine.providers.map((provider) => (
        <ProviderRow key={provider.id} provider={provider} stale={stale} />
      ))}
      {!stale && connect !== null && <ConnectCommand command={connect} />}
    </Section>
  );
}
