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
import { QrScanner } from "../components/QrScanner.tsx";
import { useI18n } from "../i18n.ts";
import { usePresentation } from "../presentation.tsx";
import { Text, TextInput } from "../text.tsx";
import { Button } from "../ui.tsx";
import { totpAddressOf } from "./totpQr.ts";

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
  readonly onSubmit?: (() => void) | undefined;
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

/**
 * A login's one-time code key: pasted, or read from the QR code the site
 * shows, which fills the field with the address it carries. `hint` says what
 * the key is, until a scan says where it came from.
 */
export function TotpField({
  label,
  hint,
  value,
  onChange,
  editable = true,
  onSubmit,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly editable?: boolean;
  readonly onSubmit?: () => void;
}) {
  const { t } = useI18n();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  return (
    <View className="gap-2">
      <SecretField
        label={label}
        value={value}
        onChange={(typed) => {
          setScanned(false);
          onChange(typed);
        }}
        editable={editable}
        onSubmit={onSubmit}
      />
      <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
        {scanned ? t("totp.scanned") : hint}
      </Text>
      <View className="flex-row">
        <Button
          variant="outline"
          label={t("totp.scan")}
          disabled={!editable}
          onPress={() => setScanning(true)}
        />
      </View>
      {scanning && (
        <QrScanner
          decode={totpAddressOf}
          words={{
            title: t("totp.scan.title"),
            wrongCode: t("totp.scan.notKey"),
            refused: t("totp.scan.refused"),
            denied: t("totp.scan.denied"),
          }}
          onClose={() => setScanning(false)}
          onScanned={(address) => {
            setScanning(false);
            setScanned(true);
            onChange(address);
          }}
        />
      )}
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

/**
 * Replaces the master password: the current one, then the new one twice,
 * with the line that says nobody can give it back.
 */
export function ChangePasswordForm({
  vault,
  onDone,
  onCancel,
}: {
  readonly vault: VaultHandle;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [tried, setTried] = useState(false);
  const { busy, failure, run } = useVaultRequest();
  // No master password is shorter than the minimum, so a shorter current one is wrong.
  const wrongCurrent = current.length < MIN_MASTER_PASSWORD_LENGTH;
  const short = next.length < MIN_MASTER_PASSWORD_LENGTH;
  const mismatch = again !== next;
  const problem = !tried
    ? null
    : wrongCurrent
      ? t("vault.wrong")
      : short
        ? t("vault.tooShort", { count: MIN_MASTER_PASSWORD_LENGTH })
        : mismatch
          ? t("vault.mismatch")
          : null;
  const submit = () => {
    setTried(true);
    const was = masterPassword(current);
    const becomes = masterPassword(next);
    if (mismatch || Option.isNone(was) || Option.isNone(becomes)) return;
    run(() => vault.changePassword(was.value, becomes.value), onDone);
  };
  return (
    <View className="gap-3">
      <SecretField
        label={t("vault.current")}
        value={current}
        onChange={setCurrent}
        invalid={(tried && wrongCurrent) || failure !== null}
      />
      <SecretField
        label={t("vault.next")}
        value={next}
        onChange={setNext}
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
        <Button label={t("vault.cancel")} onPress={onCancel} />
        <Button variant="primary" label={t("vault.changePassword")} onPress={submit} held={busy} />
      </View>
    </View>
  );
}

/**
 * Unlocks the vault with its master password, saying while too many wrong
 * ones make it wait. `actions` go beside the button.
 */
function UnlockVaultForm({
  status,
  vault,
  actions,
}: {
  readonly status: VaultStatus;
  readonly vault: VaultHandle;
  readonly actions?: ReactNode;
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
      <View className="flex-row flex-wrap items-center justify-end gap-2">
        {actions}
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

/** A sentence on why the vault cannot take a login, with the screen's actions under it. */
function GateNote({
  text,
  actions,
}: {
  readonly text: string | null;
  readonly actions?: ReactNode;
}) {
  if (text === null && actions === undefined) return null;
  return (
    <View className="gap-3">
      {text !== null && <Text className="text-sm text-muted-foreground">{text}</Text>}
      {actions !== undefined && (
        <View className="flex-row flex-wrap items-center justify-end gap-2">{actions}</View>
      )}
    </View>
  );
}

/**
 * What a screen shows while the vault cannot take a login: its setup or its
 * unlock, in place, or why there is none. `actions`, such as a card's
 * Dismiss, go beside the form's own button, or under the sentence. Null once
 * the vault is unlocked.
 */
export function VaultGate({
  view,
  vault,
  actions,
}: {
  readonly view: VaultView;
  readonly vault: VaultHandle;
  readonly actions?: ReactNode;
}) {
  const { t } = useI18n();
  switch (view._tag) {
    case "loading":
      return <GateNote text={null} actions={actions} />;
    case "unsupported":
      return <GateNote text={t("vault.unsupported")} actions={actions} />;
    case "ready":
      switch (view.status.state) {
        case "unlocked":
          return null;
        case "newer":
          return <GateNote text={t("vault.newer")} actions={actions} />;
        case "uninitialized":
          return (
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">{t("vault.notSetUp")}</Text>
              <SetupVaultForm vault={vault} actions={actions} />
            </View>
          );
        case "locked":
          return (
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">{t("vault.lockedBody")}</Text>
              <UnlockVaultForm status={view.status} vault={vault} actions={actions} />
            </View>
          );
      }
  }
}
