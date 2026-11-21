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
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectCommand, ProviderRow } from "../components/Engine.tsx";
import { Quiet, Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { DevicesSection } from "./Devices.tsx";
import { NotificationsSection, YouSection } from "./Profile.tsx";
import { ServerSection, ThisPhoneSection } from "./ThisPhone.tsx";
import { UsageSection } from "./Usage.tsx";

/**
 * Everything that is not about one bot. Coming to it reads the settings and
 * the devices again, for what another device changed, and the turns bots
 * spent are read while it is in front.
 */
export function SettingsScreen() {
  const client = useJ3Client();
  const insets = useSafeAreaInsets();
  const status = useEngineStatus();
  const engine = status._tag === "ready" ? status.value : null;
  const engineStale = status._tag === "ready" && status.stale;
  const connected = useConnection()._tag === "connected";
  const recent = useRecentTurns(useIsFocused());
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
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
    >
      <EngineSection engine={engine} stale={engineStale} />
      <UsageSection
        engine={engine}
        engineStale={engineStale}
        recent={recent.state}
        onLoadMore={recent.loadMore}
        onRetry={recent.retry}
      />
      <YouSection connected={connected} />
      {/* Without pushes in this build, the section offers nothing for this phone itself:
          once the app receives them, it passes `allowOnThisPhone`. */}
      <NotificationsSection connected={connected} />
      <DevicesSection connected={connected} />
      <ServerSection />
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
        <Quiet>{t("details.loading")}</Quiet>
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
          <Text
            className={`text-sm font-medium ${stale ? "text-muted-foreground" : "text-blocked"}`}
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
