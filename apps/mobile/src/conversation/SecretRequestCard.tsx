// SPDX-License-Identifier: AGPL-3.0-or-later
import { webAddress } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { SecretRequestEntry } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import * as Redacted from "effect/Redacted";
import { ExternalLink, KeyRound } from "lucide-react-native";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { Text, TextInput } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";

const closedText: Record<Exclude<SecretRequestEntry["status"], "pending">, KeyWith> = {
  provided: "secret.provided",
  declined: "secret.declined",
  expired: "secret.expired",
};

/**
 * A bot asking for a credential only the operator has. The value is typed
 * into a masked field and handed on as a `Redacted`, so it never reaches a
 * log, and nothing on the phone keeps it: not the drafts, not the keyboard's
 * suggestions. The field lives only as long as the request waits; once it is
 * answered, here or elsewhere, or expires, the value is gone and the card
 * only says what happened.
 */
export function SecretRequestCard({ entry }: { readonly entry: SecretRequestEntry }) {
  const { t } = useI18n();
  const pending = entry.status === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  return (
    <CardFrame
      icon={KeyRound}
      title={pending ? t("secret.pending") : t("secret.title")}
      attention={pending}
    >
      <View className="gap-1">
        <Text className="text-sm font-medium text-foreground">{entry.label}</Text>
        {entry.reason !== "" && (
          <Text className="text-sm text-muted-foreground">{entry.reason}</Text>
        )}
      </View>
      {entry.status === "pending" ? (
        <SecretForm entry={entry} onAnswer={answered} />
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {t(closedText[entry.status])}
        </Text>
      )}
    </CardFrame>
  );
}

/**
 * The masked field and its actions. Unmounted with the request, taking the
 * typed value with it. While an answer is on its way they take no second one
 * but keep their place.
 */
function SecretForm({
  entry,
  onAnswer,
}: {
  readonly entry: SecretRequestEntry;
  readonly onAnswer: () => void;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const submitting = useSubmitting(entry.id);
  const placeholderColor = useColor("accent-muted-foreground");
  const [value, setValue] = useState("");
  const link = webAddress(entry.url);
  const provide = () => {
    if (value === "" || submitting) return;
    onAnswer();
    void client.provideSecret(entry.id, { _tag: "provide", value: Redacted.make(value) });
    setValue("");
  };
  const decline = () => {
    if (submitting) return;
    onAnswer();
    void client.provideSecret(entry.id, { _tag: "decline" });
  };
  return (
    <>
      <TextInput
        value={value}
        onChangeText={setValue}
        editable={!submitting}
        secureTextEntry
        autoComplete="off"
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        importantForAutofill="no"
        textContentType="none"
        returnKeyType="done"
        onSubmitEditing={provide}
        placeholder={entry.placeholder ?? undefined}
        placeholderTextColor={placeholderColor}
        accessibilityLabel={entry.label}
        accessibilityHint={entry.reason === "" ? undefined : entry.reason}
        className="min-h-11 rounded-md border border-input bg-surface px-3 text-base text-foreground"
      />
      <Text className="text-xs text-muted-foreground">{t("secret.unseen")}</Text>
      <View className="flex-row flex-wrap items-center gap-2">
        {link !== null && (
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(link)}
            className="min-h-11 flex-row items-center gap-1"
          >
            <Text className="text-xs text-muted-foreground underline">{t("secret.getOne")}</Text>
            <Icon icon={ExternalLink} size={12} color="accent-muted-foreground" />
          </Pressable>
        )}
        <View className="ms-auto flex-row gap-2">
          <Button variant="quiet" label={t("secret.decline")} onPress={decline} held={submitting} />
          <Button
            variant="primary"
            label={t("secret.provide")}
            onPress={provide}
            disabled={value === ""}
            held={submitting}
          />
        </View>
      </View>
    </>
  );
}
