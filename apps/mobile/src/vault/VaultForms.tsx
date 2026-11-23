// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VaultFailure, VaultHandle, VaultResult, VaultView } from "@j3-bots/client-runtime";
import { clockTime } from "@j3-bots/client-runtime/presentation";
import { unlockWaitsUntil, vaultFailureText } from "@j3-bots/client-runtime/wording";
import { MIN_MASTER_PASSWORD_LENGTH, MasterPassword, type VaultStatus } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { Problem } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { usePresentation } from "../presentation.tsx";
import { Text, TextInput } from "../text.tsx";
import { Button } from "../ui.tsx";

const decodePassword = Schema.decodeUnknownOption(MasterPassword);

/** The password typed, as the contract takes it; none while it is too short or too long. */
const masterPassword = (typed: string): Option.Option<MasterPassword> =>
  decodePassword(Redacted.make(typed));

/** Why a request to the vault failed, in a sentence. */
export function useVaultFailureText(): (failure: VaultFailure) => string {
  const ctx = usePresentation();
  return (failure) => vaultFailureText(failure, ctx);
}

/**
 * A masked field with its label above it. Nothing typed is kept by the
 * keyboard: no suggestions, no autofill.
 */
export function SecretField({
  label,
  value,
  onChange,
  invalid = false,
  editable = true,
  onSubmit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly invalid?: boolean;
  readonly editable?: boolean;
  readonly onSubmit?: () => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        aria-invalid={invalid}
        value={value}
        onChangeText={onChange}
        editable={editable}
        secureTextEntry
        autoComplete="off"
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        importantForAutofill="no"
        textContentType="none"
        returnKeyType="done"
        onSubmitEditing={onSubmit}
        className={`min-h-11 rounded-md border bg-muted px-3 text-base text-foreground ${invalid ? "border-blocked" : "border-transparent"}`}
      />
    </View>
  );
}

/** Runs `request` once at a time, saying how its last run failed. */
export function useVaultRequest() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const run = <A,>(request: () => Promise<VaultResult<A>>, onDone?: (value: A) => void) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    void request().then(
      (result) => {
        setBusy(false);
        if (result._tag === "failed") setFailure(result.failure);
        else onDone?.(result.value);
      },
      () => {
        setBusy(false);
        setFailure({ _tag: "unexpected" });
      },
    );
  };
  return { busy, failure, run };
}

/**
 * Creates the vault's master password: typed twice, with the line that says
 * nobody can give it back. `actions` go beside the button, such as a Skip.
 */
export function SetupVaultForm({
  vault,
  onDone,
  actions,
}: {
  readonly vault: VaultHandle;
  readonly onDone?: () => void;
  readonly actions?: ReactNode;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [tried, setTried] = useState(false);
  const { busy, failure, run } = useVaultRequest();
  const short = password.length < MIN_MASTER_PASSWORD_LENGTH;
  const mismatch = again !== password;
  const problem = !tried
    ? null
    : short
      ? t("vault.tooShort", { count: MIN_MASTER_PASSWORD_LENGTH })
      : mismatch
        ? t("vault.mismatch")
        : null;
  const submit = () => {
    setTried(true);
    const checked = masterPassword(password);
    if (mismatch || Option.isNone(checked)) return;
    run(
      () => vault.setup(checked.value),
      () => {
        setPassword("");
        setAgain("");
        onDone?.();
      },
    );
  };
  return (
    <View className="w-full gap-3">
      <SecretField
        label={t("vault.password")}
        value={password}
        onChange={setPassword}
        invalid={tried && short}
      />
      <SecretField
        label={t("vault.confirm")}
        value={again}
        onChange={setAgain}
        invalid={tried && !short && mismatch}
        onSubmit={submit}
      />
      <Text className="text-xs text-muted-foreground">{t("vault.noRecovery")}</Text>
      <Problem>{problem ?? (failure === null ? null : failureText(failure))}</Problem>
      <View className="flex-row flex-wrap items-center justify-end gap-2">
        {actions}
        <Button variant="primary" label={t("vault.create")} onPress={submit} held={busy} />
      </View>
    </View>
  );
}

/** Unlocks the vault with its master password, saying while too many wrong ones make it wait. */
function UnlockVaultForm({
  status,
  vault,
}: {
  readonly status: VaultStatus;
  readonly vault: VaultHandle;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const failureText = useVaultFailureText();
  const [password, setPassword] = useState("");
  const { busy, failure, run } = useVaultRequest();
  const waiting = unlockWaitsUntil(status, ctx.now);
  const submit = () => {
    const checked = masterPassword(password);
    if (Option.isNone(checked) || waiting !== null) return;
    run(
      () => vault.unlock(checked.value),
      () => setPassword(""),
    );
  };
  return (
    <View className="gap-3">
      <SecretField
        label={t("vault.password")}
        value={password}
        onChange={setPassword}
        invalid={failure !== null}
        onSubmit={submit}
      />
      <Problem>
        {waiting !== null
          ? t("vault.wait", { time: clockTime(waiting, ctx) })
          : failure === null
            ? null
            : failureText(failure)}
      </Problem>
      <View className="flex-row justify-end">
        <Button
          variant="primary"
          label={t("vault.unlock")}
          onPress={submit}
          disabled={waiting !== null || password.length < MIN_MASTER_PASSWORD_LENGTH}
          held={busy}
        />
      </View>
    </View>
  );
}

/**
 * What a screen shows while the vault cannot take a login: its setup or its
 * unlock, in place, or why there is none. Null once it is unlocked.
 */
export function VaultGate({
  view,
  vault,
}: {
  readonly view: VaultView;
  readonly vault: VaultHandle;
}) {
  const { t } = useI18n();
  switch (view._tag) {
    case "loading":
      return null;
    case "unsupported":
      return <Text className="text-sm text-muted-foreground">{t("vault.unsupported")}</Text>;
    case "ready":
      switch (view.status.state) {
        case "unlocked":
          return null;
        case "newer":
          return <Text className="text-sm text-muted-foreground">{t("vault.newer")}</Text>;
        case "uninitialized":
          return (
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">{t("vault.notSetUp")}</Text>
              <SetupVaultForm vault={vault} />
            </View>
          );
        case "locked":
          return (
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">{t("vault.lockedBody")}</Text>
              <UnlockVaultForm status={view.status} vault={vault} />
            </View>
          );
      }
  }
}
