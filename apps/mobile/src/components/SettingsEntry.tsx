// SPDX-License-Identifier: AGPL-3.0-or-later
import { useNavigation } from "@react-navigation/native";
import { Settings } from "lucide-react-native";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Icon } from "./Icon.tsx";

/** The way into Settings, at the end of the roster's header and of the first run's. */
export function SettingsEntry() {
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  return (
    <PressScale
      depth="round"
      accessibilityRole="button"
      accessibilityLabel={t("settings.title")}
      onPress={() => navigation.navigate("settings")}
      className="size-11 items-center justify-center rounded-pill active:bg-muted"
    >
      <Icon icon={Settings} size={20} color="accent-foreground" />
    </PressScale>
  );
}
