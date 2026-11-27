// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { useNavigation } from "@react-navigation/native";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { Icon } from "../components/Icon.tsx";
import { Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { readySecrets, SecretsGate } from "./SecretsForms.tsx";

/**
 * Settings' Secrets page: the way to the secrets, with how many there are;
 * while they cannot be used, why.
 */
export function SecretsSection() {
  const { t, plural } = useI18n();
  const navigation = useNavigation<Navigation>();
  const secrets = useJ3Client().secrets;
  const view = useReadable(secrets.view);
  const ready = readySecrets(view);
  const count = ready?.secrets?.length ?? null;
  return (
    <Section open>
      <SecretsGate view={view} />
      {ready !== null && (
        <PressScale
          depth="row"
          accessibilityRole="button"
          accessibilityLabel={t("secrets.title")}
          accessibilityHint={count === null ? undefined : plural("secrets.count", count)}
          onPress={() => navigation.navigate("secrets")}
          className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 active:bg-muted"
        >
          <Icon icon={KeyRound} color="accent-muted-foreground" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
            {t("secrets.title")}
          </Text>
          {count !== null && (
            <Text className="text-xs text-muted-foreground">{plural("secrets.count", count)}</Text>
          )}
          <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
        </PressScale>
      )}
    </Section>
  );
}
