// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "./Icon.tsx";
import { useI18n } from "../i18n.ts";

/**
 * A command to run on the machine J3 Bots runs on, wrapped to any width and
 * selectable, with a button that copies it, to paste into a terminal there.
 */
export function CommandLine({ command }: { readonly command: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <View className="flex-row items-center gap-2 rounded-md bg-code-background py-1.5 ps-3.5 pe-1.5">
      <Text selectable className="flex-1 font-mono text-sm text-foreground">
        {command}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? t("firstRun.connect.copied") : t("firstRun.connect.copy")}
        onPress={() => {
          void Clipboard.setStringAsync(command).then(() => setCopied(true));
        }}
        className="min-h-11 flex-row items-center gap-1.5 rounded-md border border-input bg-surface px-3 active:bg-muted"
      >
        <Icon icon={copied ? Check : Copy} size={16} color="accent-foreground" />
        <Text className="text-sm font-medium text-foreground">
          {copied ? t("firstRun.connect.copied") : t("commandLine.copy")}
        </Text>
      </Pressable>
    </View>
  );
}
