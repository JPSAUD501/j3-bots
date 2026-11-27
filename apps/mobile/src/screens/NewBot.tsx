// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { ScrollView } from "react-native";
import { Text } from "../text.tsx";
import { useDiscardGuard } from "../components/form.tsx";
import { NewBotForm } from "../components/NewBotForm.tsx";
import { useI18n } from "../i18n.ts";
import { type Screens, useReplaceWithConversation } from "../navigation.tsx";
import { Button } from "../ui.tsx";

type Props = NativeStackScreenProps<Screens, "newBot">;

/** A new bot: once it exists, its conversation opens in place of this screen, and it asks the rest. */
export function NewBotScreen({ navigation }: Props) {
  const { t } = useI18n();
  const openConversation = useReplaceWithConversation();
  const [typed, setTyped] = useState(false);
  const leave = useDiscardGuard(typed);
  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-4 p-4"
    >
      <Text className="text-sm text-muted-foreground">{t("newBot.body")}</Text>
      <NewBotForm
        onTypedChange={setTyped}
        cancel={<Button label={t("newBot.cancel")} onPress={navigation.goBack} />}
        onCreated={(botId) => leave(() => openConversation({ _tag: "bot", botId }))}
      />
    </ScrollView>
  );
}
