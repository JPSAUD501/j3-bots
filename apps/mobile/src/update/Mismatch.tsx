// SPDX-License-Identifier: AGPL-3.0-or-later
import { behind, type J3Client } from "@j3-bots/client-runtime";
import { layout } from "@j3-bots/design-tokens";
import { View } from "react-native";
import { useI18n } from "../i18n.ts";
import { ChangeServer } from "../Leave.tsx";
import { Body, Button, Centered, Title } from "../ui.tsx";
import { PhoneUpdatePanel, ServerUpdatePanel } from "./UpdatePanels.tsx";

/**
 * The server speaks another protocol than this app. The side that is behind
 * is the one to update, and it can be updated from here: a server behind the
 * app takes its update from this phone, over the update routes, which do not
 * need the protocol; an app behind the server updates itself. Once the server
 * is back on a protocol the app speaks, the app connects on its own.
 */
export function Mismatch(props: {
  readonly server: URL;
  readonly client: J3Client;
  readonly serverProtocol: number;
  readonly serverVersion: string;
}) {
  const { t } = useI18n();
  const side = behind(props.serverProtocol);
  const words = { address: props.server.host, version: props.serverVersion };
  return (
    <Centered>
      <Title>
        {side === "server"
          ? t("gate.incompatible.serverBehindTitle")
          : t("gate.incompatible.appBehindTitle")}
      </Title>
      <Body>
        {side === "server"
          ? t("gate.incompatible.serverBehindBody", words)
          : t("gate.incompatible.appBehindBody", words)}
      </Body>
      <View className="w-full gap-3" style={{ maxWidth: layout.textColumn }}>
        {side === "server" ? (
          <ServerUpdatePanel place="behind" />
        ) : (
          <PhoneUpdatePanel place="behind" />
        )}
      </View>
      <View className="flex-row flex-wrap items-center justify-center gap-2">
        <Button label={t("gate.retry")} onPress={props.client.reconnectNow} />
        <ChangeServer />
      </View>
    </Centered>
  );
}
