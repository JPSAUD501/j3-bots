// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsFailure } from "@j3-bots/client-runtime";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { SecretAskEntry } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import { KeyRound, LockKeyhole } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { Problem, SwitchRow, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { useBots } from "../presentation.tsx";
import { askAccess, askDraft, secretNameOf } from "../secrets/drafts.ts";
import {
  readySecrets,
  SecretField,
  TotpField,
  useSecretsFailureText,
} from "../secrets/SecretsForms.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";

/**
 * A bot asking the operator for a secret: a login for a site, or a value.
 * What the operator types goes from this card straight to the server, never
 * to the bot, and the keyboard keeps none of it. Once saved, declined or
 * expired, here or elsewhere, the card only says which.
 */
export function SecretAskCard({ entry }: { readonly entry: SecretAskEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const view = useReadable(client.secrets.view);
  const bots = useBots();
  const submitting = useSubmitting(entry.id);
  const pending = entry.status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const botId = entry.author._tag === "bot" ? entry.author.botId : null;
  const botName = (botId === null ? undefined : bots.get(botId))?.profile.name ?? t("bot.unknown");
  const login = entry.secret._tag === "login";
  const decline = () => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "dismiss" });
  };
  return (
    <CardFrame
      icon={login ? LockKeyhole : KeyRound}
      title={t(login ? "ask.title.login" : "ask.title.value", { name: botName })}
      attention={pending}
    >
      <View className="gap-1">
        {entry.note !== "" && <Text className="text-sm text-foreground">{entry.note}</Text>}
        <Text className="text-xs text-muted-foreground">
          {t("ask.savedAs", { secret: entry.name, name: botName })}
        </Text>
      </View>
      {pending ? (
        readySecrets(view) === null ? (
          <View className="gap-3">
            <Text className="text-sm text-muted-foreground">{t("ask.unavailable")}</Text>
            <View className="flex-row justify-end">
              <Button
                variant="outline"
                label={t("ask.decline")}
                onPress={decline}
                held={submitting}
              />
            </View>
          </View>
        ) : (
          <AskForm
            entry={entry}
            botName={botName}
            onSaved={answered}
            onDecline={decline}
            submitting={submitting}
          />
        )
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {entry.status._tag === "saved"
            ? t("ask.saved", { secret: entry.name, name: botName })
            : entry.status._tag === "declined"
              ? t("ask.declined", { name: botName })
              : t("ask.expired", { name: botName })}
        </Text>
      )}
    </CardFrame>
  );
}

/** The ask's fields and actions. Unmounted with the ask, taking what was typed with it. */
function AskForm({
  entry,
  botName,
  onSaved,
  onDecline,
  submitting,
}: {
  readonly entry: SecretAskEntry;
  readonly botName: string;
  readonly onSaved: () => void;
  readonly onDecline: () => void;
  readonly submitting: boolean;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const failureText = useSecretsFailureText();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [value, setValue] = useState("");
  const [everyBot, setEveryBot] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SecretsFailure | null>(null);
  const botId = entry.author._tag === "bot" ? entry.author.botId : null;
  const { secret } = entry;
  // A card from before secrets may name its login otherwise than a secret takes.
  const name = secretNameOf(entry.name);
  const draft = askDraft(secret, { username, password, totp, value });
  const busy = saving || submitting;
  const missing = secret._tag === "login" ? password === "" : value === "";

  const save = () => {
    setTried(true);
    if (busy || Option.isNone(name) || Option.isNone(draft)) return;
    setSaving(true);
    setFailure(null);
    void client.secrets
      .add({ name: name.value, draft: draft.value, access: askAccess(everyBot, botId) }, entry.id)
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

  const failureLine = (found: SecretsFailure): string => {
    if (found._tag === "refused" && found.error._tag === "Conflict") {
      if (found.error.reason === "secret-name-taken") {
        return t("ask.nameTaken", { secret: entry.name });
      }
    }
    if (
      found._tag === "refused" &&
      found.error._tag === "Invalid" &&
      found.error.reason === "totp"
    ) {
      return t("ask.totpInvalid");
    }
    return failureText(found);
  };
  const problem = Option.isNone(name)
    ? t("secrets.nameInvalid")
    : tried && missing
      ? t(secret._tag === "login" ? "ask.passwordRequired" : "ask.valueRequired")
      : failure === null
        ? null
        : failureLine(failure);

  return (
    <View className="gap-3">
      {secret._tag === "login" ? (
        <>
          <View className="gap-1">
            <Text className="text-sm text-foreground">{t("ask.site")}</Text>
            <Text selectable className="text-base text-foreground">
              {secret.origin}
            </Text>
          </View>
          <TextField
            label={t("ask.username")}
            value={username}
            onChange={setUsername}
            autoCapitalize="none"
            readOnly={busy}
          />
          <SecretField
            label={t("ask.password")}
            value={password}
            onChange={setPassword}
            invalid={tried && password === ""}
            editable={!busy}
          />
          <TotpField
            label={t("ask.totp")}
            hint={t("ask.totpHint")}
            value={totp}
            onChange={setTotp}
            editable={!busy}
            onSubmit={save}
          />
        </>
      ) : (
        <SecretField
          label={t("ask.value")}
          hint={t("ask.valueHint")}
          value={value}
          onChange={setValue}
          invalid={tried && value === ""}
          editable={!busy}
          onSubmit={save}
        />
      )}
      <SwitchRow
        label={t("ask.everyBot")}
        value={everyBot}
        onChange={setEveryBot}
        readOnly={busy}
      />
      <Text className="text-xs text-muted-foreground">{t("ask.unseen", { name: botName })}</Text>
      <Problem>{problem}</Problem>
      <View className="flex-row justify-end gap-2">
        <Button variant="outline" label={t("ask.decline")} onPress={onDecline} held={busy} />
        <Button
          variant="primary"
          label={t("ask.save")}
          onPress={save}
          disabled={missing || Option.isNone(name)}
          held={busy}
        />
      </View>
    </View>
  );
}
