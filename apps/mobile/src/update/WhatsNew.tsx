// SPDX-License-Identifier: AGPL-3.0-or-later
import { releaseName } from "@j3-bots/client-runtime";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { layout } from "@j3-bots/design-tokens";
import { useNavigation } from "@react-navigation/native";
import { ChevronRight, Sparkles } from "lucide-react-native";
import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { NoticeRow } from "./UpdateNotice.tsx";
import { useWhatsNew } from "./whatsNew.ts";

// "What's new" on the phone: a row at the end of Settings, always there while
// the server has anything to show, and once after an update a quiet line
// over the roster, "New in 0.14", until it is opened. Its screen lists what
// each release lets people do, the newest first.

/** Each release's entries, the newest release first. Seeing it drops the mark. */
export function WhatsNewScreen() {
  const { t, locale } = useI18n();
  const insets = useSafeAreaInsets();
  const client = useJ3Client();
  const { view, open } = useWhatsNew();
  useEffect(() => {
    if (view.mark !== null) open();
  }, [view.mark, open]);
  useEffect(() => {
    client.recordUsage({ event: "feature.used", properties: { feature: "whats-new" } });
  }, [client]);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        width: "100%",
        maxWidth: layout.textColumn,
        alignSelf: "center",
        gap: 32,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <Text className="text-sm text-muted-foreground">{t("whatsNew.description")}</Text>
      {view.releases.map((release) => (
        <View key={release.version} className="gap-4">
          <Text accessibilityRole="header" className="text-xs font-medium text-muted-foreground">
            {t("whatsNew.release", { version: releaseName(release.version) })}
          </Text>
          {release.entries.map((entry) => (
            <View key={entry.title.en} className="gap-1">
              <Text className="text-base font-medium text-foreground">{entry.title[locale]}</Text>
              <Text className="text-sm text-foreground">{entry.body[locale]}</Text>
              {entry.where !== undefined && (
                <Text className="text-sm text-muted-foreground">{entry.where[locale]}</Text>
              )}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

/** The line over the roster after an update, until What's new is opened. */
export function WhatsNewNotice() {
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  const { mark } = useWhatsNew().view;
  if (mark === null) return null;
  return (
    <NoticeRow
      text={t("whatsNew.mark", { version: releaseName(mark) })}
      hint={t("whatsNew.open")}
      onOpen={() => navigation.navigate("whatsNew")}
    />
  );
}

/** What's new's row at the end of Settings, with its mark after an update. */
export function WhatsNewRow() {
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  const { releases, mark } = useWhatsNew().view;
  if (releases.length === 0) return null;
  const title = t("whatsNew.title");
  const marked = mark === null ? null : t("whatsNew.mark", { version: releaseName(mark) });
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={marked === null ? title : `${title}, ${marked}`}
      onPress={() => navigation.push("whatsNew")}
      className="min-h-12 flex-row items-center gap-3 rounded-lg px-3 active:bg-muted"
    >
      <Icon icon={Sparkles} size={20} color="accent-muted-foreground" />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
        {title}
      </Text>
      {marked !== null && (
        <View className="flex-row items-center gap-1.5">
          <View className="size-1.5 rounded-pill bg-accent" />
          <Text className="text-xs font-medium text-accent">{marked}</Text>
        </View>
      )}
      <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
    </PressScale>
  );
}
