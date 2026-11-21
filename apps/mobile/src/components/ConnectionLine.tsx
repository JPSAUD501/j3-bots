// SPDX-License-Identifier: AGPL-3.0-or-later
import { useConnection, useJ3Client } from "@j3-bots/client-runtime/react";
import { Text, View } from "react-native";
import { useI18n } from "../i18n.ts";
import { ChangeServer } from "../Leave.tsx";
import { Button, Centered, Title } from "../ui.tsx";

/**
 * One line while the server is out of reach; nothing while connected. Once
 * the roster has loaded, a new attempt to connect is a reconnection.
 */
export function ConnectionLine(props: { readonly loaded: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const connection = useConnection();
  if (connection._tag === "offline") {
    return (
      <Text accessibilityLiveRegion="polite" className="px-4 py-2 text-sm text-muted-foreground">
        {t("connection.offline")}
      </Text>
    );
  }
  // A server whose address changed is never reached again: it can be left here.
  if (connection._tag === "waiting") {
    return (
      <View className="gap-1 px-4 py-1">
        <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
          {t("connection.unreachable")}
        </Text>
        <View className="flex-row flex-wrap items-start gap-2">
          <Button label={t("connection.retryNow")} onPress={client.reconnectNow} />
          <ChangeServer />
        </View>
      </View>
    );
  }
  if (connection._tag === "connecting" && props.loaded) {
    return (
      <Text accessibilityLiveRegion="polite" className="px-4 py-2 text-sm text-muted-foreground">
        {t("connection.reconnecting")}
      </Text>
    );
  }
  return null;
}

/** In place of what waits for the roster's first load. */
export function Connecting() {
  const { t } = useI18n();
  return (
    <Centered>
      <ConnectionLine loaded={false} />
      <Title>{t("firstRun.connecting.title")}</Title>
    </Centered>
  );
}
