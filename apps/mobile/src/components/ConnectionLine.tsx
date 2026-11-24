// SPDX-License-Identifier: AGPL-3.0-or-later
import { useConnection, useJ3Client, useServerUpdate } from "@j3-bots/client-runtime/react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "../text.tsx";
import { useI18n } from "../i18n.ts";
import { ChangeServer } from "../Leave.tsx";
import { serverUpdating } from "../update/UpdateNotice.tsx";
import { Button, Centered, Title } from "../ui.tsx";
import { Working } from "./States.tsx";

/**
 * One line while the server is out of reach; nothing while connected. Once
 * the roster has loaded, a new attempt to connect is a reconnection. While
 * the server updates, being out of reach is its restart, which the update's
 * own line says.
 */
export function ConnectionLine(props: { readonly loaded: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const connection = useConnection();
  const updating = serverUpdating(useServerUpdate());
  if (updating && connection._tag !== "offline") return null;
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

/**
 * In place of what waits for the roster's first load. Why the server is out
 * of reach, when the app knows, sits along the top as it does over the roster.
 */
export function Connecting() {
  const { t } = useI18n();
  return (
    <View className="flex-1 bg-background">
      {/* Clear of the status bar where no header is above it: the roster and the conversation draw their own. */}
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ConnectionLine loaded={false} />
        <Centered>
          <Title>{t("firstRun.connecting.title")}</Title>
          <Working />
        </Centered>
      </SafeAreaView>
    </View>
  );
}
