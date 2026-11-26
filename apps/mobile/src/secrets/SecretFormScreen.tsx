// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsFailure, SecretsResult } from "@j3-bots/client-runtime";
import { typedOrigins } from "@j3-bots/client-runtime/presentation";
import { useConnection, useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { MAX_SECRET_NAME_LENGTH, type Secret, type SecretAccess } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Option from "effect/Option";
import { useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import {
  ChoiceRow,
  FormScreen,
  Section,
  SwitchRow,
  TextField,
  useDiscardGuard,
} from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { Text } from "../text.tsx";
import { Body, Button, Centered } from "../ui.tsx";
import { loginDraft, secretChanges, secretNameOf, valueDraft } from "./drafts.ts";
import {
  AccessChoice,
  readySecrets,
  SecretField,
  SecretsGate,
  TotpField,
  useSecretsFailureText,
} from "./SecretsForms.tsx";

type Props = NativeStackScreenProps<Screens, "secretForm">;

type Kind = Secret["kind"]["_tag"];

/**
 * Adds a secret (`id` null) or changes one, on a screen of its own. While
 * secrets cannot be used it says why, or asks for the old vault's password,
 * in place of the form.
 */
export function SecretFormScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const secrets = useJ3Client().secrets;
  const view = useReadable(secrets.view);
  const { id } = route.params;
  const ready = readySecrets(view);
  const secret = id === null ? null : (ready?.secrets?.find((listed) => listed.id === id) ?? null);
  const title =
    id === null ? t("secrets.add") : t("secrets.editTitle", { name: secret?.name ?? "" });
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  if (ready === null) {
    return (
      <ScrollView className="flex-1 bg-background" keyboardShouldPersistTaps="handled">
        <Section>
          <SecretsGate view={view} secrets={secrets} />
        </Section>
      </ScrollView>
    );
  }
  if (id !== null && secret === null) {
    // Still being read, or deleted, here or from another device.
    return ready.secrets === null ? (
      <View className="flex-1 bg-background" />
    ) : (
      <View className="flex-1 bg-background">
        <Centered>
          <Body>{t("secrets.gone")}</Body>
          <Button variant="secondary" label={t("secrets.back")} onPress={navigation.goBack} />
        </Centered>
      </View>
    );
  }
  return <SecretForm secret={secret} onClose={navigation.goBack} />;
}

/**
 * The secret's fields. Adding one, the operator picks a login or a value
 * first, and the bots that may use it. Changing one, the values left empty
 * keep what it has, and a login's one-time code key can be removed. Save
 * sends what was typed straight to the server and closes the screen once it
 * has it.
 */
function SecretForm({
  secret,
  onClose,
}: {
  readonly secret: Secret | null;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const secrets = useJ3Client().secrets;
  const connected = useConnection()._tag === "connected";
  const failureText = useSecretsFailureText();
  const editing = secret !== null;
  const initialSites = secret?.kind._tag === "login" ? secret.kind.origins.join("\n") : "";
  const [kind, setKind] = useState<Kind>(secret?.kind._tag ?? "login");
  const [name, setName] = useState<string>(secret?.name ?? "");
  const [sites, setSites] = useState(initialSites);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [removeTotp, setRemoveTotp] = useState(false);
  const [value, setValue] = useState("");
  const [access, setAccess] = useState<SecretAccess>({ _tag: "bots", botIds: [] });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SecretsFailure | null>(null);
  const login = kind === "login";
  const hasTotp = secret?.kind._tag === "login" && secret.kind.hasTotp;
  const secretName = secretNameOf(name);
  const origins = typedOrigins(sites);
  const unsaved =
    name !== (secret?.name ?? "") ||
    sites !== initialSites ||
    username !== "" ||
    password !== "" ||
    totp !== "" ||
    removeTotp ||
    value !== "";
  const leave = useDiscardGuard(unsaved && !saving);

  const settle = (result: SecretsResult<unknown>) => {
    setSaving(false);
    if (result._tag === "failed") setFailure(result.failure);
    else leave(onClose);
  };
  const send = (request: () => Promise<SecretsResult<unknown>>) => {
    setSaving(true);
    setFailure(null);
    void request().then(settle, () => settle({ _tag: "failed", failure: { _tag: "unexpected" } }));
  };

  const save = () => {
    setTried(true);
    if (saving || Option.isNone(secretName)) return;
    if (secret !== null) {
      const changes = secretChanges(secret, {
        name,
        sites,
        username,
        password,
        totp,
        removeTotp,
        value,
      });
      if (Option.isSome(changes)) send(() => secrets.update(secret.id, changes.value));
      return;
    }
    const draft = login
      ? Option.flatMap(origins, (found) => loginDraft(found, { username, password, totp }))
      : valueDraft(value);
    if (Option.isNone(draft)) return;
    send(() => secrets.add({ name: secretName.value, draft: draft.value, access }, null));
  };

  // The name and the sites say what is wrong with them under each; a value's field only turns red.
  const missingPassword = tried && !editing && login && password === "";
  const missingValue = tried && !editing && !login && value === "";
  const problem =
    failure !== null
      ? failureText(failure)
      : missingPassword
        ? t("secrets.passwordRequired")
        : missingValue
          ? t("secrets.valueRequired")
          : null;

  return (
    <FormScreen
      problem={problem}
      offline={!connected}
      actions={
        <>
          <Button label={t("secrets.cancel")} onPress={onClose} />
          <Button variant="primary" label={t("secrets.save")} onPress={save} held={saving} />
        </>
      }
    >
      {!editing && (
        <View accessibilityRole="radiogroup" className="gap-2">
          <ChoiceRow
            kind="one"
            label={t("secrets.kind.login")}
            description={t("secrets.kind.loginHint")}
            selected={login}
            onPress={() => setKind("login")}
          />
          <ChoiceRow
            kind="one"
            label={t("secrets.kind.value")}
            description={t("secrets.kind.valueHint")}
            selected={!login}
            onPress={() => setKind("value")}
          />
        </View>
      )}
      <TextField
        label={t("secrets.name")}
        hint={t("secrets.nameHint")}
        value={name}
        onChange={setName}
        maxLength={MAX_SECRET_NAME_LENGTH}
        autoCapitalize="none"
        error={tried && Option.isNone(secretName) ? t("secrets.nameInvalid") : null}
      />
      {login ? (
        <>
          <TextField
            label={t("secrets.sites")}
            hint={t("secrets.sitesHint")}
            value={sites}
            onChange={setSites}
            multiline
            autoCapitalize="none"
            error={tried && Option.isNone(origins) ? t("secrets.siteInvalid") : null}
          />
          <TextField
            label={t("secrets.field.username")}
            {...(editing ? { hint: t("secrets.keepUsername") } : {})}
            value={username}
            onChange={setUsername}
            autoCapitalize="none"
          />
          <SecretField
            label={t("secrets.field.password")}
            hint={editing ? t("secrets.keepPassword") : undefined}
            value={password}
            onChange={setPassword}
            invalid={missingPassword}
            editable={!saving}
          />
          {!removeTotp && (
            <TotpField
              label={t("secrets.field.totp")}
              hint={hasTotp ? t("secrets.keepTotp") : t("ask.totpHint")}
              value={totp}
              onChange={setTotp}
              editable={!saving}
              onSubmit={save}
            />
          )}
          {hasTotp && (
            <SwitchRow
              label={t("secrets.removeTotp")}
              value={removeTotp}
              onChange={setRemoveTotp}
              readOnly={saving}
            />
          )}
        </>
      ) : (
        <SecretField
          label={t("secrets.field.value")}
          hint={editing ? t("secrets.keepValue") : t("ask.valueHint")}
          value={value}
          onChange={setValue}
          invalid={missingValue}
          editable={!saving}
          onSubmit={save}
        />
      )}
      {!editing && (
        <View className="gap-1">
          <Text className="text-sm text-foreground">{t("secrets.bots")}</Text>
          <AccessChoice access={access} onChange={setAccess} readOnly={saving} />
        </View>
      )}
    </FormScreen>
  );
}
