// SPDX-License-Identifier: AGPL-3.0-or-later
import { Theater } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

/**
 * What the details of a bot or room behind the scenes say under their
 * profile, after Stop: one quiet line that it is out of the roster's list,
 * and Bring back to the list, which leaves the details open.
 */
export function BackstageNotice(props: {
  readonly name: string;
  readonly onBringBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <View className="mx-5 mt-2 flex-row items-center gap-3">
      <Icon icon={Theater} size={16} color="accent-muted-foreground" />
      <Text className="min-w-0 flex-1 text-sm text-muted-foreground">{t("backstage.notice")}</Text>
      <Button
        variant="secondary"
        label={t("backstage.bringBack")}
        accessibilityLabel={t("backstage.bringBackName", { name: props.name })}
        onPress={props.onBringBack}
      />
    </View>
  );
}
