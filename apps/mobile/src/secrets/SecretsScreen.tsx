// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { Secret } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { useLayoutEffect } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { Problem, Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import {
  accessText,
  lastUsedText,
  readySecrets,
  SecretsGate,
  useSecretsFailureText,
} from "./SecretsForms.tsx";

type Props = NativeStackScreenProps<Screens, "secrets">;

/**
 * The operator's secrets, each opening its own screen, and Add a secret.
 * While they cannot be used, it says why.
 */
export function SecretsScreen({ navigation }: Props) {
  const { t, plural } = useI18n();
  const insets = useSafeAreaInsets();
  const secrets = useJ3Client().secrets;
  const view = useReadable(secrets.view);
  const failureText = useSecretsFailureText();
  const title = t("secrets.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  const ready = readySecrets(view);
  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <Section>
        <Quiet>{t("secrets.intro")}</Quiet>
        <SecretsGate view={view} />
      </Section>
      {ready !== null && (
        <Section
          title={ready.secrets === null ? undefined : plural("secrets.count", ready.secrets.length)}
        >
          {ready.listFailure !== null ? (
            <Problem>{failureText(ready.listFailure)}</Problem>
          ) : ready.secrets === null ? (
            <SkeletonRows />
          ) : ready.secrets.length === 0 ? (
            <Quiet>{t("secrets.empty")}</Quiet>
          ) : (
            ready.secrets.map((secret) => (
              <SecretRow
                key={secret.id}
                secret={secret}
                onOpen={() => navigation.navigate("secret", { id: secret.id })}
              />
            ))
          )}
          <View className="flex-row">
            <Button
              variant="secondary"
              label={t("secrets.add")}
              onPress={() => navigation.navigate("secretForm", { id: null })}
            />
          </View>
        </Section>
      )}
    </ScrollView>
  );
}

/**
 * One secret: its name; what it is, a login with its sites or a value; the
 * bots that may use it; and when one last did.
 */
function SecretRow({ secret, onOpen }: { readonly secret: Secret; readonly onOpen: () => void }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const bots = useBots();
  const kind =
    secret.kind._tag === "login"
      ? [t("secrets.kind.login"), ...secret.kind.origins].join(" · ")
      : t("secrets.kind.value");
  const usage = `${accessText(secret.access, bots, ctx.i18n)} · ${lastUsedText(secret, ctx)}`;
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={secret.name}
      accessibilityHint={`${kind}. ${usage}`}
      onPress={onOpen}
      className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted"
    >
      <Icon icon={KeyRound} color="accent-muted-foreground" />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-mono text-base text-foreground">
          {secret.name}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {kind}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {usage}
        </Text>
      </View>
      <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
    </PressScale>
  );
}
