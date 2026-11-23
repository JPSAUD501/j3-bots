// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VaultFailure } from "@j3-bots/client-runtime";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import {
  type CredentialDraft,
  CredentialDraft as CredentialDraftSchema,
  type CredentialRequestEntry,
  type SiteOrigin,
  siteOriginOf,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { LockKeyhole } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { Problem, SwitchRow, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { useBots } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { SecretField, useVaultFailureText, VaultGate } from "../vault/VaultForms.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";

const decodeDraft = Schema.decodeUnknownOption(CredentialDraftSchema);

/** The host a site's origin names, as a login's first name. */
const hostOf = (origin: SiteOrigin) => new URL(origin).host;

/**
 * A bot asking the operator to save a login in the vault. What the operator
 * types goes from this card straight to the vault, never to the bot, and the
 * keyboard keeps none of it. While the vault cannot take it, the card offers
 * its setup or unlock in place. Once saved or dismissed, here or elsewhere,
 * the card only says which.
 */
export function CredentialRequestCard({ entry }: { readonly entry: CredentialRequestEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const view = useReadable(client.vault.view);
  const bots = useBots();
  const submitting = useSubmitting(entry.id);
  const pending = entry.status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const botId = entry.author._tag === "bot" ? entry.author.botId : null;
  const botName = (botId === null ? undefined : bots.get(botId))?.profile.name ?? t("bot.unknown");
  const unlocked = view._tag === "ready" && view.status.state === "unlocked";
  const dismiss = () => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "dismiss" });
  };
  return (
    <CardFrame icon={LockKeyhole} title={t("login.title")} attention={pending}>
      <View className="gap-1">
        <Text className="text-sm font-medium text-foreground">{entry.origin}</Text>
        {entry.note !== "" && <Text className="text-sm text-muted-foreground">{entry.note}</Text>}
      </View>
      {entry.status._tag === "pending" ? (
        unlocked ? (
          <LoginForm
            entry={entry}
            botName={botName}
            onSaved={answered}
            onDismiss={dismiss}
            submitting={submitting}
          />
        ) : (
          <>
            <VaultGate view={view} vault={client.vault} />
            <View className="flex-row justify-end">
              <Button
                variant="quiet"
                label={t("login.dismiss")}
                onPress={dismiss}
                held={submitting}
              />
            </View>
          </>
        )
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {entry.status._tag === "saved"
            ? t("login.saved", { name: entry.status.name })
            : t("login.dismissed")}
        </Text>
      )}
    </CardFrame>
  );
}

/** The login's fields and actions. Unmounted with the request, taking what was typed with it. */
function LoginForm({
  entry,
  botName,
  onSaved,
  onDismiss,
  submitting,
}: {
  readonly entry: CredentialRequestEntry;
  readonly botName: string;
  readonly onSaved: () => void;
  readonly onDismiss: () => void;
  readonly submitting: boolean;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const failureText = useVaultFailureText();
  const [site, setSite] = useState<string>(entry.origin);
  const [name, setName] = useState(() => hostOf(entry.origin));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [allow, setAllow] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const botId = entry.author._tag === "bot" ? entry.author.botId : null;

  const origin = siteOriginOf(site);
  const draft: Option.Option<CredentialDraft> = Option.flatMap(origin, (found) =>
    decodeDraft({
      name: name.trim(),
      origins: [found],
      username: Redacted.make(username),
      password: Redacted.make(password),
      totp: totp.trim() === "" ? null : Redacted.make(totp.trim()),
    }),
  );
  const busy = saving || submitting;
  const save = () => {
    setTried(true);
    if (busy || Option.isNone(draft)) return;
    setSaving(true);
    setFailure(null);
    void client.vault
      .save({ ...draft.value, allowedBots: allow && botId !== null ? [botId] : [] }, entry.id)
      .then(
        (result) => {
          setSaving(false);
          if (result._tag === "failed") setFailure(result.failure);
          else onSaved();
        },
        () => {
          setSaving(false);
          setFailure({ _tag: "unexpected" });
        },
      );
  };

  return (
    <View className="gap-3">
      <TextField
        label={t("login.site")}
        value={site}
        onChange={setSite}
        autoCapitalize="none"
        error={tried && Option.isNone(origin) ? t("login.siteInvalid") : null}
      />
      <TextField label={t("login.name")} value={name} onChange={setName} maxLength={80} />
      <TextField
        label={t("login.username")}
        value={username}
        onChange={setUsername}
        autoCapitalize="none"
      />
      <SecretField
        label={t("login.password")}
        value={password}
        onChange={setPassword}
        invalid={tried && password === ""}
        editable={!busy}
      />
      <View className="gap-1">
        <SecretField
          label={t("login.totp")}
          value={totp}
          onChange={setTotp}
          editable={!busy}
          onSubmit={save}
        />
        <Text className="text-xs text-muted-foreground">{t("login.totpHint")}</Text>
      </View>
      {botId !== null && (
        <SwitchRow
          label={t("login.allow", { name: botName })}
          value={allow}
          onChange={setAllow}
          readOnly={busy}
        />
      )}
      <Text className="text-xs text-muted-foreground">{t("login.unseen", { name: botName })}</Text>
      <Problem>{failure === null ? null : failureText(failure)}</Problem>
      <View className="flex-row justify-end gap-2">
        <Button variant="outline" label={t("login.dismiss")} onPress={onDismiss} held={busy} />
        <Button
          variant="primary"
          label={t("login.save")}
          onPress={save}
          disabled={password === "" || name.trim() === ""}
          held={busy}
        />
      </View>
    </View>
  );
}
