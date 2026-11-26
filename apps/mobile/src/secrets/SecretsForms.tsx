// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  SecretsFailure,
  SecretsHandle,
  SecretsResult,
  SecretsView,
} from "@j3-bots/client-runtime";
import {
  activityTime,
  secretsFailureText,
  secretsStateText,
} from "@j3-bots/client-runtime/wording";
import type { PresentationContext } from "@j3-bots/client-runtime/wording";
import {
  type Bot,
  type BotId,
  OldVaultPassword,
  type Secret,
  type SecretAccess,
} from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { Problem, SkeletonRows, SwitchRow } from "../components/form.tsx";
import { QrScanner } from "../components/QrScanner.tsx";
import { useI18n } from "../i18n.ts";
import { useBotList } from "../presentation.tsx";
import { Text, TextInput } from "../text.tsx";
import { Button } from "../ui.tsx";
import { totpAddressOf } from "./totpQr.ts";

const decodeOldPassword = Schema.decodeUnknownOption(OldVaultPassword);

/** Why a request about secrets failed, in a sentence. */
export function useSecretsFailureText(): (failure: SecretsFailure) => string {
  const i18n = useI18n();
  return (failure) => secretsFailureText(failure, i18n);
}

/**
 * A masked field with its label above it and its hint under it. Nothing
 * typed is kept by the keyboard: no suggestions, no autofill.
 */
export function SecretField({
  label,
  value,
  onChange,
  hint,
  invalid = false,
  editable = true,
  onSubmit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string | undefined;
  readonly invalid?: boolean;
  readonly editable?: boolean;
  readonly onSubmit?: (() => void) | undefined;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
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
      {hint !== undefined && <Text className="text-xs text-muted-foreground">{hint}</Text>}
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
export function useSecretsRequest() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SecretsFailure | null>(null);
  const run = <A,>(request: () => Promise<SecretsResult<A>>, onDone?: (value: A) => void) => {
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
 * A vault from before secrets, opened with its password typed one last
 * time; the server keeps the logins without it from then on.
 */
function OldVaultForm({ secrets }: { readonly secrets: SecretsHandle }) {
  const { t } = useI18n();
  const failureText = useSecretsFailureText();
  const [password, setPassword] = useState("");
  const { busy, failure, run } = useSecretsRequest();
  const submit = () => {
    const checked = decodeOldPassword(Redacted.make(password));
    if (Option.isNone(checked)) return;
    run(
      () => secrets.openOldVault(checked.value),
      () => setPassword(""),
    );
  };
  return (
    <View className="gap-3">
      <Text accessibilityRole="header" className="text-base font-medium text-foreground">
        {t("secrets.oldVault.title")}
      </Text>
      <Text className="text-sm text-muted-foreground">{t("secrets.oldVault.body")}</Text>
      <SecretField
        label={t("secrets.oldVault.password")}
        value={password}
        onChange={setPassword}
        invalid={failure !== null}
        editable={!busy}
        onSubmit={submit}
      />
      <Problem>{failure === null ? null : failureText(failure)}</Problem>
      <View className="flex-row justify-end">
        <Button
          variant="primary"
          label={t("secrets.oldVault.open")}
          onPress={submit}
          disabled={password === ""}
          held={busy}
        />
      </View>
      <Text className="text-xs text-muted-foreground">{t("secrets.oldVault.forgot")}</Text>
    </View>
  );
}

/**
 * What a screen about secrets shows while they cannot be used: rows on their
 * way while their state is read, the old vault's password, or why there are
 * none. Null once they are ready.
 */
export function SecretsGate({
  view,
  secrets,
}: {
  readonly view: SecretsView;
  readonly secrets: SecretsHandle;
}): ReactNode {
  const i18n = useI18n();
  if (view._tag === "loading") return <SkeletonRows count={1} />;
  if (view.status.state === "ready") return null;
  if (view.status.state === "old-vault") return <OldVaultForm secrets={secrets} />;
  return (
    <Text className="text-sm text-muted-foreground">{secretsStateText(view.status, i18n)}</Text>
  );
}

/** The secrets as listed while they are ready, and why they are not read; null otherwise. */
export const readySecrets = (
  view: SecretsView,
): Extract<SecretsView, { readonly _tag: "ready" }> | null =>
  view._tag === "ready" && view.status.state === "ready" ? view : null;

/** Which bots may use a secret, in a few words: every bot, or their names. */
export function accessText(
  access: SecretAccess,
  bots: ReadonlyMap<BotId, Bot>,
  { t }: I18n,
): string {
  if (access._tag === "every-bot") return t("secrets.everyBot");
  const names = access.botIds.flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [bot.profile.name];
  });
  return names.length === 0 ? t("secrets.noBot") : names.join(", ");
}

/** When a bot last used a secret and which, or that none has. */
export function lastUsedText(secret: Secret, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  if (secret.lastUse === null) return t("secrets.neverUsed");
  const when = activityTime(secret.lastUse.at, ctx);
  const name = ctx.botName(secret.lastUse.botId);
  return name === null ? t("secrets.lastUsedBy", { when }) : t("secrets.lastUsed", { name, when });
}

/**
 * Which bots may use a secret: Every bot, or, with it off, each bot by name.
 * Turning Every bot off keeps none but the bots it names.
 */
export function AccessChoice({
  access,
  onChange,
  readOnly = false,
}: {
  readonly access: SecretAccess;
  readonly onChange: (access: SecretAccess) => void;
  readonly readOnly?: boolean;
}) {
  const { t } = useI18n();
  const bots = useBotList();
  const chosen = access._tag === "bots" ? access.botIds : [];
  const toggle = (botId: BotId, on: boolean) =>
    onChange({
      _tag: "bots",
      botIds: on ? [...chosen, botId] : chosen.filter((id) => id !== botId),
    });
  return (
    <View className="gap-1">
      <SwitchRow
        label={t("secrets.everyBot")}
        value={access._tag === "every-bot"}
        onChange={(every) => onChange(every ? { _tag: "every-bot" } : { _tag: "bots", botIds: [] })}
        readOnly={readOnly}
      />
      {access._tag === "bots" &&
        bots.map((bot) => (
          <SwitchRow
            key={bot.id}
            label={bot.profile.name}
            value={chosen.includes(bot.id)}
            onChange={(on) => toggle(bot.id, on)}
            readOnly={readOnly}
          />
        ))}
    </View>
  );
}
