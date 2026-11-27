// SPDX-License-Identifier: AGPL-3.0-or-later
import { addressOf } from "@j3-bots/client-runtime/presentation";
import { useState } from "react";
import { View } from "react-native";
import { Sheet } from "../components/Sheet.tsx";
import { useI18n } from "../i18n.ts";
import { Text, TextInput } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";

/**
 * A web address to go to, typed with the keyboard already up: for a new
 * tab, or for the tab shown. What is not an address says so under the field.
 */
export function AddressSheet({
  open,
  title,
  onClose,
  onGo,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  /** Goes to `url`, an address the person means. */
  readonly onGo: (url: string) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const muted = useColor("accent-muted-foreground");
  const close = () => {
    setTyped("");
    setWrong(false);
    onClose();
  };
  const go = () => {
    const url = addressOf(typed);
    if (url === null) {
      setWrong(true);
      return;
    }
    setTyped("");
    setWrong(false);
    onGo(url);
  };
  return (
    <Sheet open={open} title={title} onClose={close}>
      <View className="gap-3">
        <TextInput
          value={typed}
          onChangeText={(text) => {
            setTyped(text);
            setWrong(false);
          }}
          onSubmitEditing={go}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          accessibilityLabel={t("browser.viewer.address")}
          placeholder={t("browser.address.placeholder")}
          placeholderTextColor={muted}
          className="min-h-11 rounded-lg border border-input bg-background px-3 text-base text-foreground"
        />
        {wrong && (
          <Text accessibilityLiveRegion="polite" className="text-sm text-blocked">
            {t("browser.viewer.badAddress")}
          </Text>
        )}
        <Button variant="primary" label={t("browser.address.go")} onPress={go} />
      </View>
    </Sheet>
  );
}
