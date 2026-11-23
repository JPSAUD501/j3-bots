// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { LANGUAGES } from "@j3-bots/contracts";
import { LANGUAGE_NAMES } from "@j3-bots/i18n";
import { useState } from "react";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { ChoiceRow, Problem, Quiet, Section, Segmented } from "../components/form.tsx";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import { ChangeServer } from "../Leave.tsx";
import { session } from "../platform/platform.ts";
import {
  type Appearance,
  type LanguageChoice,
  setAppearance,
  setLanguage,
  usePreferences,
} from "../preferences.ts";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";

/** The server this phone talks to, and leaving it for another. */
export function ServerSection() {
  const { t } = useI18n();
  const state = useReadable(session.state);
  if (state._tag !== "open") return null;
  return (
    <Section title={t("settings.server")}>
      <Text selectable face="mono" className="text-sm text-foreground">
        {state.origin.origin}
      </Text>
      <View className="items-start">
        <ChangeServer />
      </View>
    </Section>
  );
}

/**
 * Choices kept on this phone only, and signing it out. Each language is named
 * in itself, so it can be found from any other.
 */
export function ThisPhoneSection() {
  const { t } = useI18n();
  const { appearance, language } = usePreferences();
  const appearances: ReadonlyArray<{ readonly value: Appearance; readonly label: string }> = [
    { value: "system", label: t("settings.system.short") },
    { value: "light", label: t("settings.light") },
    { value: "dark", label: t("settings.dark") },
  ];
  // Each language is named in itself, so it can be found from any other.
  const languages: ReadonlyArray<{ readonly value: LanguageChoice; readonly label: string }> = [
    { value: "system", label: t("settings.system") },
    ...LANGUAGES.map((language) => ({ value: language, label: LANGUAGE_NAMES[language] })),
  ];
  return (
    <Section title={t("settings.thisDevice")}>
      <View className="gap-2">
        <Text className="text-sm text-foreground">{t("settings.appearance")}</Text>
        <Segmented
          label={t("settings.appearance")}
          value={appearance}
          options={appearances}
          onChange={setAppearance}
        />
      </View>
      <View accessibilityRole="radiogroup" className="gap-2">
        <Text className="text-sm text-foreground">{t("settings.language")}</Text>
        {languages.map(({ value, label }) => (
          <ChoiceRow
            key={value}
            kind="one"
            label={label}
            selected={language === value}
            onPress={() => setLanguage(value)}
          />
        ))}
      </View>
      <View className="items-start gap-2 pt-1">
        <Quiet>{t("settings.signOut.hint")}</Quiet>
        <SignOut />
      </View>
    </Section>
  );
}

/**
 * Signs this phone out once the operator confirms, in the runtime's four
 * steps: it stops sending, revokes the pairing on the server when connected,
 * deletes the pairing's drafts and unsent messages, then its credential.
 * Success opens the pairing screen, so only a failure stays shown here.
 */
function SignOut() {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const confirm = useConfirm();
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const signOut = () => {
    setState("pending");
    void client.signOut().then((result) => {
      // Paired again meanwhile: the phone stays signed in under that pairing.
      if (result._tag === "paired-anew") {
        say(
          t(
            result.revoked
              ? "settings.signOut.pairedAnew"
              : "settings.signOut.pairedAnewStillListed",
          ),
        );
      }
      setState(result._tag === "failed" ? "failed" : "idle");
    });
  };
  return (
    <View className="items-start gap-1">
      <Button
        variant="destructive"
        label={state === "pending" ? t("settings.signOut.pending") : t("settings.signOut")}
        disabled={state === "pending"}
        onPress={() =>
          confirm({
            title: t("settings.signOut.title"),
            body: t("settings.signOut.body.mobile"),
            cancel: t("settings.signOut.cancel"),
            confirm: t("settings.signOut"),
            onConfirm: signOut,
          })
        }
      />
      <Problem>{state === "failed" ? t("settings.signOut.failed") : null}</Problem>
    </View>
  );
}
