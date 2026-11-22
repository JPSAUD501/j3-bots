// SPDX-License-Identifier: AGPL-3.0-or-later
import { canRunBots, connectCommand } from "@j3-bots/client-runtime/presentation";
import { useEngineStatus } from "@j3-bots/client-runtime/react";
import { engineProblem } from "@j3-bots/client-runtime/wording";
import type { BotState, EngineStatus } from "@j3-bots/contracts";
import { ensemble } from "@j3-bots/design-tokens";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n.ts";
import { useOpenConversation } from "../navigation.tsx";
import { Body, Title } from "../ui.tsx";
import { BotAvatar } from "./Avatar.tsx";
import { Connecting } from "./ConnectionLine.tsx";
import { ConnectCommand, ProviderRow } from "./Engine.tsx";
import { NewBotForm } from "./NewBotForm.tsx";
import { SettingsEntry } from "./SettingsEntry.tsx";

const idle: BotState = { _tag: "idle" };

/** Three idle bots: the picture for screens where the team is still to come. */
function Ensemble() {
  return (
    <View
      className="flex-row items-end"
      style={{ gap: ensemble.gap }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {ensemble.members.map(({ shape, color, size }) => (
        <BotAvatar key={shape} avatar={{ shape, color }} state={idle} size={size} />
      ))}
    </View>
  );
}

/**
 * Before the first bot: checks that the engine runs and a provider is ready,
 * then asks for a name, and opens the new bot's conversation. No form for
 * the bot's settings; the bot asks the rest itself. Settings stays in reach,
 * as the roster's header has it.
 */
export function FirstRun() {
  const insets = useSafeAreaInsets();
  const status = useEngineStatus();
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* Settings is in reach before the first bot: devices, the server, signing out, the language. */}
      <View className="flex-row justify-end pe-2 pt-3">
        <SettingsEntry />
      </View>
      {status._tag === "ready" ? <FirstRunBody engine={status.value} /> : <Connecting />}
    </View>
  );
}

function FirstRunBody({ engine }: { readonly engine: EngineStatus }) {
  const i18n = useI18n();
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const openConversation = useOpenConversation();
  const problem = engineProblem(engine, i18n);
  const connect = connectCommand(engine);
  const ready = engine.providers.some(canRunBots);
  return (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="grow justify-center gap-4 px-6 py-10"
      contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
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
