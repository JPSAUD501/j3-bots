// SPDX-License-Identifier: AGPL-3.0-or-later
import { suggestionConnect } from "@j3-bots/client-runtime/presentation";
import { useConnectors, useJ3Client } from "@j3-bots/client-runtime/react";
import type { ConnectorAuthEntry, ConnectorSuggestionEntry } from "@j3-bots/contracts";
import { Plug, PlugZap } from "lucide-react-native";
import { View } from "react-native";
import { ConnectorTile } from "../connectors/parts.tsx";
import { useOpenConnectors } from "../connectors/intents.ts";
import { useI18n } from "../i18n.ts";
import { useBotList } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";

/**
 * A bot suggests a service it would use for the task at hand. Connect opens
 * the connector's page, or lets the bot use one the operator added; Not now
 * closes the card for good in this conversation. Neither wakes the bot.
 */
export function ConnectorSuggestionCard({ entry }: { readonly entry: ConnectorSuggestionEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const state = useConnectors();
  const bots = useBotList();
  const open = useOpenConnectors();
  const say = useSay();
  const submitting = useSubmitting(entry.id);
  const pending = entry.status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const connect = () => {
    if (submitting) return;
    const { letIn, open: opening } = suggestionConnect(
      entry,
      state._tag === "ready" ? state.value : [],
      bots,
    );
    if (letIn !== null) {
      answered();
      void client.connectors.setBots(letIn.connectorId, letIn.grant).then((result) => {
        if (result._tag === "failed") say(t("connectorCard.failed"));
      });
    }
    if (opening !== null) open(opening);
  };
  return (
    <CardFrame icon={Plug} title={t("connectorCard.suggest.title")} attention={pending}>
      <View className="flex-row items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-medium text-foreground">
            {entry.name}
          </Text>
          <Text className="text-sm text-muted-foreground">{entry.reason}</Text>
        </View>
      </View>
      {pending ? (
        <View className="flex-row flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            label={t("connectorCard.notNow")}
            held={submitting}
            onPress={() => {
              answered();
              void client.answerCard(entry.id, { _tag: "dismiss" });
            }}
          />
          <Button
            variant="primary"
            label={t("connectorCard.connect")}
            held={submitting}
            onPress={connect}
          />
        </View>
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {entry.status._tag === "connected"
            ? t("connectorCard.connected", { name: entry.name })
            : t("connectorCard.dismissed")}
        </Text>
      )}
    </CardFrame>
  );
}

/**
 * A connector a bot called needs the operator to sign in again. Sign in opens
 * the connector's page with its sign-in started. The card closes once the
 * connector works again, or is removed.
 */
export function ConnectorAuthCard({ entry }: { readonly entry: ConnectorAuthEntry }) {
  const { t } = useI18n();
  const open = useOpenConnectors();
  const pending = entry.status === "pending";
  const { outcome } = useOutcomeFocus(pending);
  return (
    <CardFrame icon={PlugZap} title={t("connectorCard.auth.title")} attention={pending}>
      <View className="flex-row items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <Text className="min-w-0 flex-1 text-base text-foreground">
          {t("connectorCard.auth.body", { name: entry.name })}
        </Text>
      </View>
      {pending ? (
        <View className="flex-row justify-end">
          <Button
            variant="primary"
            label={t("connectorCard.signIn")}
            onPress={() =>
              open({
                at: {
                  _tag: "connector",
                  connectorId: entry.connectorId,
                  signIn: true,
                  added: false,
                },
                forBot: entry.author.botId,
                suggestion: null,
              })
            }
          />
        </View>
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {entry.status === "signed-in"
            ? t("connectorCard.signedIn")
            : t("connectorCard.removed", { name: entry.name })}
        </Text>
      )}
    </CardFrame>
  );
}
