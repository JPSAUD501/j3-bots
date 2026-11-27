// SPDX-License-Identifier: AGPL-3.0-or-later
import { botAccountState, modelPicker } from "@j3-bots/client-runtime/presentation";
import type { EngineStatus, ModelChoice } from "@j3-bots/contracts";
import { CircleAlert } from "lucide-react-native";
import { View } from "react-native";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { Icon } from "./Icon.tsx";

/**
 * That the AI account a bot runs on was removed or turned off, so it cannot
 * answer, and a way to choose another AI. Nothing while its account runs
 * (`botAccountState`).
 */
export function BotAccountNotice(props: {
  readonly engine: EngineStatus | null;
  readonly model: ModelChoice;
  readonly name: string;
  readonly onChoose: () => void;
}) {
  const { t } = useI18n();
  const state = botAccountState(props.engine, props.model);
  if (state === "ok") return null;
  const account =
    modelPicker(props.engine, []).accounts.find(
      (candidate) => candidate.providerId === props.model.providerId,
    )?.name ?? props.model.providerId;
  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-2 rounded-md border border-border bg-surface px-3 py-3"
    >
      <View className="flex-row items-start gap-2">
        <View className="pt-0.5">
          <Icon icon={CircleAlert} color="accent-waiting" />
        </View>
        <Text className="min-w-0 flex-1 text-sm text-foreground">
          {state === "gone"
            ? t("botAccount.gone", { name: props.name })
            : t("botAccount.off", { account, name: props.name })}
        </Text>
      </View>
      <View className="flex-row justify-end">
        <Button variant="secondary" label={t("botAccount.choose")} onPress={props.onChoose} />
      </View>
    </View>
  );
}
