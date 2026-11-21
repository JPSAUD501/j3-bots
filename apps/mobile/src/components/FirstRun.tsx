// SPDX-License-Identifier: AGPL-3.0-or-later
import { canRunBots, connectCommand } from "@j3-bots/client-runtime/presentation";
import { useEngineStatus } from "@j3-bots/client-runtime/react";
import { engineProblem } from "@j3-bots/client-runtime/wording";
import type { BotState } from "@j3-bots/contracts";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n.ts";
import { useOpenConversation } from "../navigation.tsx";
import { Body, Title } from "../ui.tsx";
import { BotAvatar } from "./Avatar.tsx";
import { Connecting } from "./ConnectionLine.tsx";
import { ConnectCommand, ProviderRow } from "./Engine.tsx";
import { NewBotForm } from "./NewBotForm.tsx";

const idle: BotState = { _tag: "idle" };

/** Three idle bots: the picture for screens where the team is still to come. */
function Ensemble() {
  return (
    <View
      className="flex-row items-end gap-1.5"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <BotAvatar avatar={{ shape: "hexagon", color: "teal" }} state={idle} size={36} />
      <BotAvatar avatar={{ shape: "circle", color: "violet" }} state={idle} size={48} />
      <BotAvatar avatar={{ shape: "triangle", color: "orange" }} state={idle} size={36} />
    </View>
  );
}

/**
 * Before the first bot: checks that the engine runs and a provider is ready,
 * then asks for a name, and opens the new bot's conversation. No settings
 * form; the bot asks the rest itself.
 */
export function FirstRun() {
  const i18n = useI18n();
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const status = useEngineStatus();
  const openConversation = useOpenConversation();
  if (status._tag !== "ready") return <Connecting />;
  const engine = status.value;
  const problem = engineProblem(engine, i18n);
  const connect = connectCommand(engine);
  const ready = engine.providers.some(canRunBots);
  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="grow justify-center gap-4 px-6 py-10"
      contentContainerStyle={{ paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 }}
    >
      <View className="items-center gap-4">
        <Ensemble />
        {problem !== null ? (
          <>
            <Title>{problem.title}</Title>
            <Body>{problem.body}</Body>
          </>
        ) : !ready ? (
          connect === null ? (
            <>
              <Title>{t("firstRun.unavailable.title")}</Title>
              <Body>{t("firstRun.unavailable.body")}</Body>
            </>
          ) : (
            <>
              <Title>{t("firstRun.connect.title")}</Title>
              <Body>{t("firstRun.connect.body")}</Body>
            </>
          )
        ) : (
          <>
            <Title>{t("firstRun.create.title")}</Title>
            <Body>{t("firstRun.create.body")}</Body>
          </>
        )}
      </View>
      {problem === null && !ready && (
        <View className="gap-2">
          {connect !== null && <ConnectCommand command={connect} />}
          {engine.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </View>
      )}
      {problem === null && ready && (
        <NewBotForm
          primaryAtFirst
          onCreated={(botId) => openConversation({ _tag: "bot", botId })}
        />
      )}
    </ScrollView>
  );
}
