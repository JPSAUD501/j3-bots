// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  sentAsJson,
  USAGE_DATA_DOCS,
  type UsageDataSwitch,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { SentTelemetryEvent } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { useNavigation } from "@react-navigation/native";
import { ExternalLink } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { Problem, Quiet, SkeletonRows, SwitchRow } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

// The server's switch for anonymous usage data (decision 0099), in the About
// page's privacy area: one sentence of what it is, where to read more, and
// the events the server sent, exactly as they left, on a screen of their own.

/** The switch, as `view` has it, for a server that offers usage data. */
export function UsageDataRow({
  view,
  connected,
}: {
  readonly view: UsageDataSwitch;
  readonly connected: boolean;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const navigation = useNavigation<Navigation>();
  const readOnly = view.saving || view.heldOff || !connected;
  return (
    <>
      <View className="gap-1">
        <SwitchRow
          label={t("usageData.switch")}
          hint={view.heldOff ? t("usageData.heldOff") : t("usageData.body")}
          value={view.checked}
          readOnly={readOnly}
          onChange={(enabled) => {
            if (readOnly) return;
            void client.updateSettings({ section: "usage-data", changes: { enabled } });
          }}
        />
        <Problem>{view.failed ? t("settings.saveFailed") : null}</Problem>
      </View>
      <View className="flex-row flex-wrap items-center gap-x-4">
        <PressScale
          accessibilityRole="link"
          onPress={() => void Linking.openURL(USAGE_DATA_DOCS).catch(() => undefined)}
          className="min-h-11 flex-row items-center gap-1"
        >
          <Text className="text-sm text-muted-foreground underline">
            {t("usageData.learnMore")}
          </Text>
          <Icon icon={ExternalLink} size={12} color="accent-muted-foreground" />
        </PressScale>
        <Button
          variant="plain"
          label={t("usageData.seeSent")}
          disabled={!connected}
          onPress={() => navigation.push("usageDataSent")}
        />
      </View>
    </>
  );
}

type SentRead =
  | { readonly _tag: "reading" }
  | { readonly _tag: "read"; readonly events: ReadonlyArray<SentTelemetryEvent> }
  | { readonly _tag: "failed" };

/** What "See what is sent" opens: the events the server sent, newest first, each as the JSON that left it. */
export function UsageDataSentScreen() {
  const { t } = useI18n();
  const client = useJ3Client();
  const insets = useSafeAreaInsets();
  const [sent, setSent] = useState<SentRead>({ _tag: "reading" });
  // Read as the screen opens, which shows it reading, and again on Try again.
  const read = useCallback(
    () =>
      void client
        .usageDataSent()
        .then((result) =>
          setSent(
            result._tag === "done" ? { _tag: "read", events: result.value } : { _tag: "failed" },
          ),
        ),
    [client],
  );
  useEffect(read, [read]);
  const retry = () => {
    setSent({ _tag: "reading" });
    read();
  };
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        width: "100%",
        maxWidth: layout.textColumn,
        alignSelf: "center",
        gap: 16,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <Text className="text-sm text-muted-foreground">{t("usageData.sent.description")}</Text>
      <SentList sent={sent} onRetry={retry} />
    </ScrollView>
  );
}

function SentList({ sent, onRetry }: { readonly sent: SentRead; readonly onRetry: () => void }) {
  const { t } = useI18n();
  switch (sent._tag) {
    case "reading":
      return <SkeletonRows count={3} />;
    case "failed":
      return (
        <View className="items-start gap-2">
          <Problem>{t("usageData.sent.failed")}</Problem>
          <Button variant="secondary" label={t("usageData.sent.retry")} onPress={onRetry} />
        </View>
      );
    case "read":
      return sent.events.length === 0 ? (
        <Quiet>{t("usageData.sent.empty")}</Quiet>
      ) : (
        <View className="gap-2">
          {sentAsJson(sent.events).map((json, index) => (
            <Text
              key={sent.events[index]?.uuid ?? index}
              selectable
              className="rounded-md bg-muted p-3 font-mono text-xs text-foreground"
            >
              {json}
            </Text>
          ))}
        </View>
      );
  }
}
