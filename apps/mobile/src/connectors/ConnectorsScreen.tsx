// SPDX-License-Identifier: AGPL-3.0-or-later
import { useConnection, useConnectors } from "@j3-bots/client-runtime/react";
import { grantText, lastChangeText } from "@j3-bots/client-runtime/wording";
import type { Connector } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Quiet, Section, SkeletonRows } from "../components/form.tsx";
import type { Screens } from "../navigation.tsx";
import { useBotList, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { useOpenConnectors } from "./intents.ts";
import { ConnectorTile, OpenRow, StatusWord } from "./parts.tsx";
import { SkillsSection } from "./Skills.tsx";

type Props = NativeStackScreenProps<Screens, "connectors">;

/**
 * Where the operator looks after the services and skills their bots added:
 * their connectors, each with its status and its bots, then the skills. Bots
 * add both in conversation; with none yet, each says so in one line. Each
 * opens its page over this one.
 */
export function ConnectorsScreen({ navigation }: Props) {
  const ctx = usePresentation();
  const { i18n } = ctx;
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const open = useOpenConnectors();
  const bots = useBotList();
  const state = useConnectors();
  const connectors = state._tag === "ready" ? state.value : null;
  const connected = useConnection()._tag === "connected";
  const title = t("connectors.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      {!connected && (
        <View className="px-4 pt-3">
          <Quiet>{t("connectors.offline")}</Quiet>
        </View>
      )}
      <Section open title={t("connectors.yours")}>
        {connectors === null ? (
          <SkeletonRows count={1} />
        ) : connectors.length === 0 ? (
          <Quiet>{t("connectors.none")}</Quiet>
        ) : (
          connectors.map((connector) => (
            <YourRow
              key={connector.id}
              connector={connector}
              bots={grantText(connector.grant, bots, i18n)}
              changed={lastChangeText(connector.lastChange, bots, ctx)}
              onPress={() => open({ _tag: "connector", connectorId: connector.id, signIn: false })}
            />
          ))
        )}
      </Section>
      <SkillsSection
        bots={bots}
        onOpen={(skill) => navigation.push("skill", { scope: skill.scope, name: skill.name })}
      />
    </ScrollView>
  );
}

/** One of the operator's connectors: its status, which bots may use it, and who changed it last. */
function YourRow({
  connector,
  bots,
  changed,
  onPress,
}: {
  readonly connector: Connector;
  readonly bots: string;
  readonly changed: string | null;
  readonly onPress: () => void;
}) {
  return (
    <OpenRow label={connector.name} onPress={onPress}>
      <ConnectorTile name={connector.name} glyph={connector.glyph} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-base font-medium text-foreground">
          {connector.name}
        </Text>
        <StatusWord connector={connector} />
        {changed !== null && <Text className="text-xs text-muted-foreground">{changed}</Text>}
      </View>
      <Text className="text-xs text-muted-foreground">{bots}</Text>
    </OpenRow>
  );
}
