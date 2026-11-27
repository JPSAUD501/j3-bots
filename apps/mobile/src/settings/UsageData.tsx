// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import { sentAsJson, USAGE_DATA_DOCS, usageDataSwitch } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable, useSettings } from "@j3-bots/client-runtime/react";
import type { SentTelemetryEvent } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import { useNavigation } from "@react-navigation/native";
import { ExternalLink } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { Problem, Quiet, Section, SkeletonRows, SwitchRow } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

// The server's switch for anonymous usage data (decision 0099), on the About
// page: one sentence of what it is, where to read more, and the events the
// server sent, exactly as they left, on a screen of their own.

/** The switch, for a server that offers usage data; nothing for one that does not. */
export function UsageDataSection({ connected }: { readonly connected: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const navigation = useNavigation<Navigation>();
  const settings = useSettings();
  const save: SettingsSaves["usage-data"] = useReadable(client.settingsSaves["usage-data"]);
  const view = usageDataSwitch(settings._tag === "ready" ? settings.value : null, save);
  if (view === null) return null;
  const readOnly = view.saving || view.heldOff || !connected;
  return (
    <Section open title={t("usageData.title")}>
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
    </Section>
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
