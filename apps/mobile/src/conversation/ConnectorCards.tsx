// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorAuthEntry } from "@j3-bots/contracts";
import { PlugZap } from "lucide-react-native";
import { View } from "react-native";
import { ConnectorTile } from "../connectors/parts.tsx";
import { useOpenConnectors } from "../connectors/intents.ts";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus } from "./CardFrame.tsx";

/**
 * A connector a bot called, or added, needs the operator to sign in. Sign in
 * opens the connector's page with its sign-in started. The card closes once
 * the connector works, or is removed.
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
