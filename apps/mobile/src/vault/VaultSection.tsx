// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { useNavigation } from "@react-navigation/native";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { Problem, Section, SkeletonRows } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { useVaultFailureText, useVaultRequest, VaultGate } from "./VaultForms.tsx";

/**
 * The vault in Settings: whether it is locked, its setup or unlock in place,
 * and once it is unlocked, the way to its saved logins and Lock now.
 */
export function VaultSection() {
  const { t, plural } = useI18n();
  const navigation = useNavigation<Navigation>();
  const vault = useJ3Client().vault;
  const view = useReadable(vault.view);
  const failureText = useVaultFailureText();
  const { busy, failure, run } = useVaultRequest();
  if (view._tag === "loading") {
    return (
      <Section title={t("vault.title")}>
        <SkeletonRows count={1} />
      </Section>
    );
  }
  const unlocked = view._tag === "ready" && view.status.state === "unlocked";
  const locked = view._tag === "ready" && view.status.state === "locked";
  const count = view._tag === "ready" ? (view.credentials?.length ?? null) : null;
  return (
    <Section
      title={t("vault.title")}
      action={
        unlocked || locked ? (
          <Text
            className={`text-xs font-medium ${unlocked ? "text-success" : "text-muted-foreground"}`}
          >
            {t(unlocked ? "vault.state.unlocked" : "vault.state.locked")}
          </Text>
        ) : undefined
      }
    >
      <VaultGate view={view} vault={vault} />
      {unlocked && (
        <View className="gap-3">
          <PressScale
            depth="row"
            accessibilityRole="button"
            accessibilityLabel={t("vault.logins")}
            accessibilityHint={
              count === null || count === 0 ? undefined : plural("vault.count", count)
            }
            onPress={() => navigation.navigate("vault")}
            className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 active:bg-muted"
          >
            <Icon icon={KeyRound} color="accent-muted-foreground" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
              {t("vault.logins")}
            </Text>
            {count !== null && count > 0 && (
              <Text className="text-xs text-muted-foreground">{plural("vault.count", count)}</Text>
            )}
            <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
          </PressScale>
          <Problem>{failure === null ? null : failureText(failure)}</Problem>
          <View className="flex-row justify-end">
            <Button
              variant="secondary"
              label={t("vault.lock")}
              onPress={() => run(() => vault.lock())}
              held={busy}
            />
          </View>
        </View>
      )}
    </Section>
  );
}
