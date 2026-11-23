// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { View } from "react-native";
import { Problem, Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { useVaultFailureText, useVaultRequest, VaultGate } from "./VaultForms.tsx";

/**
 * The vault on the phone: whether it is locked, its setup or unlock, and Lock
 * now. Saved logins are seen and changed from the web app.
 */
export function VaultSection() {
  const { t } = useI18n();
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
          <Quiet>{t("vault.manageOnWeb")}</Quiet>
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
