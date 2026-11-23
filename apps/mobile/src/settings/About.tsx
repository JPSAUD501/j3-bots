// SPDX-License-Identifier: AGPL-3.0-or-later
import { View } from "react-native";
import { Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { PhoneUpdatePanel, ServerUpdatePanel } from "../update/UpdatePanels.tsx";

/**
 * The versions the server and this app run, and their updates: the server's,
 * which this phone starts and follows, then the app's own, each with its
 * channel.
 */
export function AboutSection(props: { readonly onLayout?: (y: number) => void }) {
  const { t } = useI18n();
  return (
    <View onLayout={(event) => props.onLayout?.(event.nativeEvent.layout.y)}>
      <Section title={t("settings.about")}>
        <Text className="text-sm font-medium text-foreground">{t("about.server")}</Text>
        <ServerUpdatePanel place="settings" />
        <Text className="pt-2 text-sm font-medium text-foreground">{t("about.thisApp")}</Text>
        <PhoneUpdatePanel place="settings" />
      </Section>
    </View>
  );
}
