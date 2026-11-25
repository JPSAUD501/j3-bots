// SPDX-License-Identifier: AGPL-3.0-or-later
import { connectorNeedsYou, connectorTone } from "@j3-bots/client-runtime/presentation";
import { useConnectors } from "@j3-bots/client-runtime/react";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { Section, SkeletonRows } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

/**
 * The services bots can use, in Settings: how many work and how many wait on
 * the operator, and the screen that manages them.
 */
export function ConnectorsSection() {
  const { t, plural } = useI18n();
  const navigation = useNavigation<Navigation>();
  const state = useConnectors();
  const connectors = state._tag === "ready" ? state.value : null;
  const working =
    connectors?.filter((connector) => connectorTone(connector) === "connected").length ?? 0;
  const needYou = connectors?.filter(connectorNeedsYou).length ?? 0;
  // "0 connected" says nothing beside what needs the operator.
  const showWorking = working > 0 || needYou === 0;
  return (
    <Section open>
      {connectors === null ? (
        <SkeletonRows count={1} />
      ) : connectors.length === 0 ? (
        <Text className="text-base text-foreground">{t("settings.connectors.none")}</Text>
      ) : (
        <Text className="text-base text-foreground">
          {showWorking && plural("settings.connectors.connected", working)}
          {needYou > 0 && (
            <Text className="text-waiting">
              {showWorking && " · "}
              {plural("settings.connectors.needsYou", needYou)}
            </Text>
          )}
        </Text>
      )}
      <View className="items-start">
        <Button
          variant="secondary"
          label={t("settings.connectors.open")}
          onPress={() => navigation.push("connectors", { forBot: null })}
        />
      </View>
    </Section>
  );
}
