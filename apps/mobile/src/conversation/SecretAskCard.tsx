// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsFailure } from "@j3-bots/client-runtime";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { SecretAskEntry, SecretAskValue, SecretRequestFieldId } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import { ExternalLink, KeyRound, LockKeyhole } from "lucide-react-native";
import { useState } from "react";
import { Linking, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { Problem, SwitchRow, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { PressScale } from "../press.tsx";
import { useBots } from "../presentation.tsx";
import { askAccess, askDraft, askedValues, secretNameOf } from "../secrets/drafts.ts";
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
 * A bot asking the operator for a secret: a login for a site, a value, or a
 * few values that go together, such as a service's client ID and secret,
 * each saved under its own name.
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
  const asked = entry.values;
  const decline = () => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "dismiss" });
  };
  return (
    <CardFrame
      icon={login ? LockKeyhole : KeyRound}
      title={t(
        login ? "ask.title.login" : asked === undefined ? "ask.title.value" : "ask.title.values",
        { name: botName },
      )}
      attention={pending}
    >
      <View className="gap-1">
        {entry.note !== "" && <Text className="text-sm text-foreground">{entry.note}</Text>}
        {asked === undefined && (
          <Text className="text-xs text-muted-foreground">
            {t("ask.savedAs", { secret: entry.name, name: botName })}
          </Text>
        )}
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
        ) : asked !== undefined ? (
          <ValuesForm
            entry={entry}
            asked={asked}
            botName={botName}
            onSaved={answered}
            onDecline={decline}
            submitting={submitting}
          />
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
            ? asked === undefined
              ? t("ask.saved", { secret: entry.name, name: botName })
              : t("ask.saved.values", { name: botName })
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
      <AskActions
        setup={entry.setup}
        several={false}
        busy={busy}
        blocked={missing || Option.isNone(name)}
        onSave={save}
        onDecline={onDecline}
      />
    </View>
  );
}

/**
 * The link to where the service issues what the bot asks for, when the bot
 * named that page, and the card's actions.
 */
function AskActions({
  setup,
  several,
  busy,
  blocked,
  onSave,
  onDecline,
}: {
  readonly setup: string | undefined;
  readonly several: boolean;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly onSave: () => void;
  readonly onDecline: () => void;
}) {
  const { t } = useI18n();
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {setup !== undefined && (
        <PressScale
          accessibilityRole="link"
          onPress={() => void Linking.openURL(setup)}
          className="min-h-11 flex-row items-center gap-1"
        >
          <Text className="text-xs text-muted-foreground underline">
            {t(several ? "ask.setup.values" : "ask.setup")}
          </Text>
          <Icon icon={ExternalLink} size={12} color="accent-muted-foreground" />
        </PressScale>
      )}
      <View className="ms-auto flex-row gap-2">
        <Button variant="outline" label={t("ask.decline")} onPress={onDecline} held={busy} />
        <Button
          variant="primary"
          label={t("ask.save")}
          onPress={onSave}
          disabled={blocked}
          held={busy}
        />
      </View>
    </View>
  );
}

/**
 * The fields of an ask for several values, one for each, in the order the
 * bot asked for them, and its actions. Unmounted with the ask, taking what
 * was typed with it.
 */
function ValuesForm({
  entry,
  asked,
  botName,
  onSaved,
  onDecline,
  submitting,
}: {
  readonly entry: SecretAskEntry;
  readonly asked: ReadonlyArray<SecretAskValue>;
  readonly botName: string;
  readonly onSaved: () => void;
  readonly onDecline: () => void;
  readonly submitting: boolean;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const failureText = useSecretsFailureText();
  const [typed, setTyped] = useState<ReadonlyMap<SecretRequestFieldId, string>>(new Map());
  const [everyBot, setEveryBot] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SecretsFailure | null>(null);
  const botId = entry.author._tag === "bot" ? entry.author.botId : null;
  const values = askedValues(entry, asked, typed, askAccess(everyBot, botId));
  const busy = saving || submitting;
  const empty = (field: SecretRequestFieldId) => (typed.get(field) ?? "").trim() === "";
  const missing = asked.some((each) => empty(each.id));
  const unnamed = asked.some((each) => Option.isNone(secretNameOf(each.name)));
  const type = (field: SecretRequestFieldId) => (value: string) =>
    setTyped((now) => new Map(now).set(field, value));

  const save = () => {
    setTried(true);
    if (busy || Option.isNone(values)) return;
    setSaving(true);
    setFailure(null);
    void client.secrets.addFromAsk(values.value).then(
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

  const problem = unnamed
    ? t("secrets.nameInvalid")
    : tried && missing
      ? t("ask.valuesRequired")
      : failure === null
        ? null
        : failure._tag === "refused" &&
            failure.error._tag === "Conflict" &&
            failure.error.reason === "secret-name-taken"
          ? t("ask.nameTaken.values")
          : failureText(failure);

  return (
    <View className="gap-3">
      {asked.map((each, index) => {
        const hint = t("ask.savedAsEach", { secret: each.name });
        const last = index === asked.length - 1;
        return each.masked ? (
          <SecretField
            key={each.id}
            label={each.label}
            hint={hint}
            value={typed.get(each.id) ?? ""}
            onChange={type(each.id)}
            invalid={tried && empty(each.id)}
            editable={!busy}
            onSubmit={last ? save : undefined}
          />
        ) : (
          <TextField
            key={each.id}
            label={each.label}
            hint={hint}
            value={typed.get(each.id) ?? ""}
            onChange={type(each.id)}
            autoCapitalize="none"
            readOnly={busy}
          />
        );
      })}
      <SwitchRow
        label={t("ask.everyBot.values")}
        value={everyBot}
        onChange={setEveryBot}
        readOnly={busy}
      />
      <Text className="text-xs text-muted-foreground">
        {t("ask.unseen.values", { name: botName })}
      </Text>
      <Problem>{problem}</Problem>
      <AskActions
        setup={entry.setup}
        several
        busy={busy}
        blocked={missing || unnamed}
        onSave={save}
        onDecline={onDecline}
      />
    </View>
  );
}
