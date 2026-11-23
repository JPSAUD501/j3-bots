// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CredentialChanges, VaultFailure, VaultResult } from "@j3-bots/client-runtime";
import { typedOrigins } from "@j3-bots/client-runtime/presentation";
import { useConnection, useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { type Credential, CredentialDraft, MAX_LABEL_LENGTH } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { FormScreen, Section, SwitchRow, TextField, useDiscardGuard } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { Text } from "../text.tsx";
import { Body, Button, Centered } from "../ui.tsx";
import { SecretField, TotpField, useVaultFailureText, VaultGate } from "./VaultForms.tsx";

type Props = NativeStackScreenProps<Screens, "credentialForm">;

const decodeDraft = Schema.decodeUnknownOption(CredentialDraft);

const decodeChanges = Schema.decodeUnknownOption(
  Schema.Struct({
    name: CredentialDraft.fields.name,
    origins: CredentialDraft.fields.origins,
    username: Schema.optionalKey(CredentialDraft.fields.username),
    password: Schema.optionalKey(CredentialDraft.fields.password),
    totp: Schema.optionalKey(CredentialDraft.fields.totp),
  }),
);

/**
 * Adds a login (`id` null) or changes one, on a screen of its own. Locked
 * from elsewhere while it is open, it offers the unlock in place, keeping
 * what was typed.
 */
export function CredentialFormScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const vault = useJ3Client().vault;
  const view = useReadable(vault.view);
  const { id } = route.params;
  const unlocked = view._tag === "ready" && view.status.state === "unlocked" ? view : null;
  const credential =
    id === null ? null : (unlocked?.credentials?.find((found) => found.id === id) ?? null);
  const title =
    id === null ? t("vault.add") : t("vault.editTitle", { name: credential?.name ?? "" });
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  if (unlocked !== null && id !== null && credential === null) {
    return unlocked.credentials === null ? (
      <View className="flex-1 bg-background" />
    ) : (
      <View className="flex-1 bg-background">
        <Centered>
          <Body>{t("vault.gone")}</Body>
          <Button variant="secondary" label={t("vault.back")} onPress={navigation.goBack} />
        </Centered>
      </View>
    );
  }
  if (unlocked === null && id !== null) {
    return (
      <ScrollView className="flex-1 bg-background" keyboardShouldPersistTaps="handled">
        <Section>
          <VaultGate view={view} vault={vault} />
        </Section>
      </ScrollView>
    );
  }
  return (
    <CredentialForm
      credential={credential}
      gate={unlocked === null ? <VaultGate view={view} vault={vault} /> : null}
      onClose={navigation.goBack}
    />
  );
}

/**
 * The login's fields. Changing one, the values left empty keep what it has;
 * its one-time code key can be removed. Save sends what was typed straight to
 * the vault and closes the screen once the vault has it.
 */
function CredentialForm({
  credential,
  gate,
  onClose,
}: {
  readonly credential: Credential | null;
  /** The vault's unlock, while it cannot take the login. */
  readonly gate: ReactNode;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const vault = useJ3Client().vault;
  const connected = useConnection()._tag === "connected";
  const failureText = useVaultFailureText();
  const [name, setName] = useState<string>(credential?.name ?? "");
  const [sites, setSites] = useState(credential?.origins.join("\n") ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [removeTotp, setRemoveTotp] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const editing = credential !== null;
  const origins = typedOrigins(sites);
  const unsaved =
    name !== (credential?.name ?? "") ||
    sites !== (credential?.origins.join("\n") ?? "") ||
    username !== "" ||
    password !== "" ||
    totp !== "" ||
    removeTotp;
  const leave = useDiscardGuard(unsaved && !saving);

  const settle = (result: VaultResult<unknown>) => {
    setSaving(false);
    if (result._tag === "failed") setFailure(result.failure);
    else leave(onClose);
  };

  const save = () => {
    setTried(true);
    if (saving || gate !== null || Option.isNone(origins) || name.trim() === "") return;
    const typedTotp = totp.trim() === "" ? null : Redacted.make(totp.trim());
    if (credential === null) {
      const draft = decodeDraft({
        name: name.trim(),
        origins: origins.value,
        username: Redacted.make(username),
        password: Redacted.make(password),
        totp: typedTotp,
      });
      if (Option.isNone(draft)) return;
      setSaving(true);
      setFailure(null);
      void vault
        .save({ ...draft.value, allowedBots: [] }, null)
        .then(settle, () => settle({ _tag: "failed", failure: { _tag: "unexpected" } }));
      return;
    }
    const changes: Option.Option<CredentialChanges> = decodeChanges({
      name: name.trim(),
      origins: origins.value,
      ...(username === "" ? {} : { username: Redacted.make(username) }),
      ...(password === "" ? {} : { password: Redacted.make(password) }),
      ...(removeTotp ? { totp: null } : typedTotp === null ? {} : { totp: typedTotp }),
    });
    if (Option.isNone(changes)) return;
    setSaving(true);
    setFailure(null);
    void vault
      .update(credential.id, changes.value)
      .then(settle, () => settle({ _tag: "failed", failure: { _tag: "unexpected" } }));
  };

  // The name and the sites say what is wrong with them under each; the password's field only turns red.
  const problem =
    failure !== null
      ? failureText(failure)
      : tried && !editing && password === ""
        ? t("vault.passwordRequired")
        : null;

  return (
    <FormScreen
      problem={problem}
      offline={!connected}
      actions={
        <>
          <Button label={t("vault.cancel")} onPress={onClose} />
          <Button
            variant="primary"
            label={t("vault.save")}
            onPress={save}
            disabled={gate !== null}
            held={saving}
          />
        </>
      }
    >
      {gate}
      <TextField
        label={t("login.name")}
        value={name}
        onChange={setName}
        maxLength={MAX_LABEL_LENGTH}
        error={tried && name.trim() === "" ? t("vault.nameRequired") : null}
      />
      <TextField
        label={t("vault.sites")}
        hint={t("vault.sitesHint")}
        value={sites}
        onChange={setSites}
        multiline
        autoCapitalize="none"
        error={tried && Option.isNone(origins) ? t("login.siteInvalid") : null}
      />
      <TextField
        label={t("login.username")}
        {...(editing ? { hint: t("vault.keepUsername") } : {})}
        value={username}
        onChange={setUsername}
        autoCapitalize="none"
      />
      <View className="gap-1">
        <SecretField
          label={t("login.password")}
          value={password}
          onChange={setPassword}
          invalid={tried && !editing && password === ""}
          editable={!saving}
        />
        {editing && (
          <Text className="text-xs text-muted-foreground">{t("vault.keepPassword")}</Text>
        )}
      </View>
      {!removeTotp && (
        <TotpField
          label={t("login.totp")}
          hint={editing && credential.hasTotp ? t("vault.keepTotp") : t("login.totpHint")}
          value={totp}
          onChange={setTotp}
          editable={!saving}
          onSubmit={save}
        />
      )}
      {editing && credential.hasTotp && (
        <SwitchRow
          label={t("vault.removeTotp")}
          value={removeTotp}
          onChange={setRemoveTotp}
          readOnly={saving}
        />
      )}
    </FormScreen>
  );
}
