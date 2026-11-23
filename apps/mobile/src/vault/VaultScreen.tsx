// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { Credential } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { Problem, Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { ChangePasswordForm, useVaultFailureText, VaultGate } from "./VaultForms.tsx";

type Props = NativeStackScreenProps<Screens, "vault">;

/**
 * The saved logins, by name and site, each opening its own screen; Add a
 * login; and the master password's change. Locked from elsewhere while it is
 * open, it offers the unlock in place.
 */
export function VaultScreen({ navigation }: Props) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const vault = useJ3Client().vault;
  const view = useReadable(vault.view);
  const failureText = useVaultFailureText();
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  const title = t("vault.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  const unlocked = view._tag === "ready" && view.status.state === "unlocked" ? view : null;
  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      {unlocked === null ? (
        <Section>
          <VaultGate view={view} vault={vault} />
        </Section>
      ) : (
        <>
          <Section title={t("vault.logins")}>
            {unlocked.listFailure !== null ? (
              <Problem>{failureText(unlocked.listFailure)}</Problem>
            ) : unlocked.credentials === null ? (
              <SkeletonRows />
            ) : unlocked.credentials.length === 0 ? (
              <Quiet>{t("vault.empty")}</Quiet>
            ) : (
              unlocked.credentials.map((credential) => (
                <CredentialRow
                  key={credential.id}
                  credential={credential}
                  onOpen={() => navigation.navigate("credential", { id: credential.id })}
                />
              ))
            )}
            <View className="flex-row">
              <Button
                variant="secondary"
                label={t("vault.add")}
                onPress={() => navigation.navigate("credentialForm", { id: null })}
              />
            </View>
          </Section>
          <Section title={t("vault.password")}>
            {changing ? (
              <ChangePasswordForm
                vault={vault}
                onCancel={() => setChanging(false)}
                onDone={() => {
                  setChanging(false);
                  setChanged(true);
                }}
              />
            ) : (
              <View className="flex-row flex-wrap items-center justify-between gap-2">
                <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
                  {changed ? t("vault.changed") : ""}
                </Text>
                <Button
                  variant="secondary"
                  label={t("vault.changePassword")}
                  onPress={() => {
                    setChanged(false);
                    setChanging(true);
                  }}
                />
              </View>
            )}
          </Section>
        </>
      )}
    </ScrollView>
  );
}

/** One saved login: its name and the sites it is for. */
function CredentialRow({
  credential,
  onOpen,
}: {
  readonly credential: Credential;
  readonly onOpen: () => void;
}) {
  const sites = credential.origins.join(" · ");
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={credential.name}
      accessibilityHint={sites}
      onPress={onOpen}
      className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted"
    >
      <Icon icon={KeyRound} color="accent-muted-foreground" />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base text-foreground">
          {credential.name}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {sites}
        </Text>
      </View>
      <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
    </PressScale>
  );
}
