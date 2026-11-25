// SPDX-License-Identifier: AGPL-3.0-or-later
import { EyeOff } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

/**
 * What the details of a hidden bot or room say under their profile, after
 * Stop: one quiet line that it is out of the roster's list, and Show, which
 * puts it back there and leaves the details open.
 */
export function HiddenNotice(props: { readonly name: string; readonly onShow: () => void }) {
  const { t } = useI18n();
  return (
    <View className="mx-5 mt-2 flex-row items-center gap-3">
      <Icon icon={EyeOff} size={16} color="accent-muted-foreground" />
      <Text className="min-w-0 flex-1 text-sm text-muted-foreground">{t("visibility.notice")}</Text>
      <Button
        variant="secondary"
        label={t("roster.unhide")}
        accessibilityLabel={t("roster.hidden.unhideName", { name: props.name })}
        onPress={props.onShow}
      />
    </View>
  );
}
