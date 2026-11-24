// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserControl } from "@j3-bots/client-runtime";
import type { BrowserInput } from "@j3-bots/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useI18n } from "../i18n.ts";
import { Text, TextInput } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { Button } from "../ui.tsx";

type Dialog = NonNullable<BrowserControl["dialog"]>;

/**
 * A dialog the page waits on while the operator holds it: an alert, a
 * confirmation, a prompt, or leaving the page. Its text is the page's own,
 * so it is shown as what the site says, never as J3 Bots' words.
 */
export function PageDialog({
  dialog,
  site,
  onAnswer,
}: {
  readonly dialog: Dialog;
  readonly site: string;
  readonly onAnswer: (answer: Extract<BrowserInput, { readonly type: "dialog" }>) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState(dialog.defaultValue);
  return (
    <View className="absolute inset-0 items-center justify-center bg-scrim px-6">
      <View
        accessibilityViewIsModal
        className="w-full max-w-sm gap-2 rounded-xl border border-border bg-surface p-6"
        style={{ elevation: OVERLAY_ELEVATION }}
      >
        <Text accessibilityRole="header" className="text-sm text-muted-foreground">
          {dialog.kind === "beforeunload"
            ? t("browser.dialog.leave")
            : t("browser.dialog.from", { site: site === "" ? "…" : site })}
        </Text>
        {dialog.message !== "" && (
          <Text className="text-base text-foreground" selectable>
            {dialog.message}
          </Text>
        )}
        {dialog.kind === "prompt" && (
          <TextInput
            value={typed}
            onChangeText={setTyped}
            autoFocus
            className="min-h-11 rounded-md border border-input px-3 text-base text-foreground"
          />
        )}
        <View className="flex-row flex-wrap justify-end gap-2 pt-4">
          {dialog.kind !== "alert" && (
            <Button
              grow
              variant="secondary"
              label={t("browser.dialog.dismiss")}
              onPress={() => onAnswer({ type: "dialog", accept: false })}
            />
          )}
          <Button
            grow
            variant="primary"
            label={t("browser.dialog.accept")}
            onPress={() =>
              onAnswer(
                dialog.kind === "prompt"
                  ? { type: "dialog", accept: true, promptText: typed }
                  : { type: "dialog", accept: true },
              )
            }
          />
        </View>
      </View>
    </View>
  );
}
