// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "./Icon.tsx";
import { useI18n } from "../i18n.ts";

/** How long the button says Copied before it offers Copy again, in ms. */
const COPIED_FOR = 2000;

/**
 * A command to run on the machine J3 Bots runs on, wrapped to any width and
 * selectable, with a button that copies it, to paste into a terminal there.
 * The button says Copied for a moment; a copy that fails says so, and that the
 * command can be selected instead.
 */
export function CommandLine({ command }: { readonly command: string }) {
  const { t } = useI18n();
  // What the last press did, as a new object each time, so a second Copy holds Copied for its own moment.
  const [outcome, setOutcome] = useState<{ readonly result: "none" | "copied" | "failed" }>({
    result: "none",
  });
  useEffect(() => {
    if (outcome.result !== "copied") return;
    const done = setTimeout(() => setOutcome({ result: "none" }), COPIED_FOR);
    return () => clearTimeout(done);
  }, [outcome]);
  const copied = outcome.result === "copied";
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2 rounded-md bg-code-background py-1.5 ps-3.5 pe-1.5">
        <Text selectable className="flex-1 font-mono text-sm text-foreground">
          {command}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? t("firstRun.connect.copied") : t("firstRun.connect.copy")}
          onPress={() => {
            Clipboard.setStringAsync(command).then(
              (saved) => setOutcome({ result: saved ? "copied" : "failed" }),
              () => setOutcome({ result: "failed" }),
            );
          }}
          className="min-h-11 flex-row items-center gap-1.5 rounded-md border border-input bg-surface px-3 active:bg-muted"
        >
          <Icon icon={copied ? Check : Copy} size={16} color="accent-foreground" />
          <Text className="text-sm font-medium text-foreground">
            {copied ? t("firstRun.connect.copied") : t("commandLine.copy")}
          </Text>
        </Pressable>
      </View>
      {outcome.result === "failed" && (
        <Text accessibilityLiveRegion="polite" className="text-xs text-blocked">
          {t("commandLine.copyFailed")}
        </Text>
      )}
    </View>
  );
}
