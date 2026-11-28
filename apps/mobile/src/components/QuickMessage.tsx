// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type QuickMessageState,
  useJ3Client,
  useQuickMessage,
} from "@j3-bots/client-runtime/react";
import { messageProblemText } from "@j3-bots/client-runtime/wording";
import type { Bot } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { SendHorizontal } from "lucide-react-native";
import { View } from "react-native";
import { usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text, TextInput } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Icon } from "./Icon.tsx";

function quickLine(state: QuickMessageState, name: string, i18n: I18n) {
  const { t } = i18n;
  switch (state._tag) {
    case "idle":
      return null;
    case "sending":
      return { text: t("card.quick.sending"), tone: "muted" as const };
    case "sent":
      return { text: t("card.quick.sent", { name }), tone: "muted" as const };
    case "invalid":
      return { text: messageProblemText(state.problem, i18n), tone: "blocked" as const };
    case "gone":
      return { text: t("card.quick.gone", { name }), tone: "blocked" as const };
    case "failed":
      return { text: t("card.quick.failed", { name }), tone: "blocked" as const };
  }
}

/**
 * A line that sends straight to the bot's conversation without opening it,
 * and says where what was sent stands, as the composer's messages do.
 */
export function QuickMessage({
  bot,
  onOpen,
  placeholder,
}: {
  readonly bot: Bot;
  readonly onOpen: () => void;
  /** What the empty field says: "Send a quick message" unless said otherwise. */
  readonly placeholder?: string;
}) {
  const i18n = usePresentation().i18n;
  const { t } = i18n;
  const client = useJ3Client();
  const name = bot.profile.name;
  const quick = useQuickMessage(bot.id, (input) => client.send(input));
  const line = quickLine(quick.state, name, i18n);
  const empty = quick.text.trim() === "";
  const muted = useColor("accent-muted-foreground");
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-1 rounded-lg border border-input bg-background ps-3">
        <TextInput
          value={quick.text}
          onChangeText={quick.setText}
          onSubmitEditing={quick.submit}
          submitBehavior="blurAndSubmit"
          returnKeyType="send"
          accessibilityLabel={t("card.quick.label", { name })}
          placeholder={placeholder ?? t("card.quick.placeholder")}
          placeholderTextColor={muted}
          className="min-h-11 min-w-0 flex-1 text-base text-foreground"
        />
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("card.quick.send")}
          accessibilityState={{ disabled: empty }}
          onPress={quick.submit}
          className="size-11 items-center justify-center rounded-pill"
        >
          <Icon icon={SendHorizontal} size={18} color="accent-muted-foreground" />
        </PressScale>
      </View>
      {line !== null && (
        <View accessibilityLiveRegion="polite" className="flex-row flex-wrap items-center gap-x-1">
          <Text
            className={`text-sm ${line.tone === "blocked" ? "text-blocked" : "text-muted-foreground"}`}
          >
            {line.text}
          </Text>
          {quick.state._tag === "sent" && (
            <PressScale
              depth="control"
              accessibilityRole="button"
              onPress={onOpen}
              className="min-h-11 justify-center"
            >
              <Text className="text-sm font-semibold text-foreground">{t("card.quick.open")}</Text>
            </PressScale>
          )}
        </View>
      )}
    </View>
  );
}
