// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsFailure, SecretsHandle, SecretsResult } from "@j3-bots/client-runtime";
import { clockTime, secretClipboard } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { activityTime } from "@j3-bots/client-runtime/wording";
import {
  type Secret,
  type SecretField,
  secretReference,
  type TotpPreview,
} from "@j3-bots/contracts";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DeleteButton, Problem, Quiet, Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Body, Button, Centered } from "../ui.tsx";
import {
  AccessChoice,
  lastUsedText,
  readySecrets,
  SecretsGate,
  useSecretsFailureText,
  useSecretsRequest,
} from "./SecretsForms.tsx";
import { shownValues } from "./shown.ts";

type Props = NativeStackScreenProps<Screens, "secret">;

/** Puts a secret's value on the clipboard, marked sensitive: Android shows no preview of it. */
const write = (text: string) => Clipboard.setStringAsync(text, { android: { isSensitive: true } });

/**
 * Copies a value from a secret's page: whether it got there. On Android it is
 * taken off the clipboard after a while, if the clipboard still holds it.
 * iOS asks the operator before an app reads what another one copied, so the
 * app could not check without asking: there it stays.
 */
const copySecret: (text: string) => Promise<boolean> =
  Platform.OS === "android"
    ? secretClipboard(
        {
          write,
          read: () => Clipboard.getStringAsync(),
          clear: () => Clipboard.setStringAsync("").then(() => undefined),
        },
        {
          active: () => AppState.currentState === "active",
          onActive: (listener) => {
            const subscription = AppState.addEventListener("change", (state) => {
              if (state === "active") listener();
            });
            return () => subscription.remove();
          },
        },
      ).copy
    : write;

const fieldLabel = {
  value: "secrets.field.value",
  username: "secrets.field.username",
  password: "secrets.field.password",
  totp: "secrets.field.totp",
} as const;

/** A secret's values, in the order its page shows them. */
const fieldsOf = (secret: Secret): ReadonlyArray<SecretField> =>
  secret.kind._tag === "value"
    ? ["value"]
    : secret.kind.hasTotp
      ? ["username", "password", "totp"]
      : ["username", "password"];

/**
 * One secret: the reference bots use it by, a login's sites, its values
 * hidden until asked for, a login's code now, the bots that may use it, when
 * it was last used and shown, Edit and Delete. A value shown goes after 30
 * seconds, and at once when the screen is left, Edit included, or the app
 * goes to the background. The server records each time one is shown.
 */
export function SecretScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const secrets = useJ3Client().secrets;
  const view = useReadable(secrets.view);
  const ready = readySecrets(view);
  const secret = ready?.secrets?.find((found) => found.id === route.params.id) ?? null;
  const name = secret?.name ?? "";
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);
  if (ready === null) {
    return (
      <ScrollView className="flex-1 bg-background" keyboardShouldPersistTaps="handled">
        <Section>
          <SecretsGate view={view} />
        </Section>
      </ScrollView>
    );
  }
  if (secret === null) {
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
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <SecretDetails
        secret={secret}
        secrets={secrets}
        onEdit={() => navigation.navigate("secretForm", { id: secret.id })}
        onDeleted={navigation.goBack}
      />
    </ScrollView>
  );
}

function SecretDetails({
  secret,
  secrets,
  onEdit,
  onDeleted,
}: {
  readonly secret: Secret;
  readonly secrets: SecretsHandle;
  readonly onEdit: () => void;
  readonly onDeleted: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const failureText = useSecretsFailureText();
  const shown = useShownValues();
  const [deleteFailure, setDeleteFailure] = useState<SecretsFailure | null>(null);
  return (
    <>
      <Section>
        <Text selectable className="text-base text-foreground">
          {t("secrets.reference", { reference: secretReference(secret.name) })}
        </Text>
        <Quiet>{lastUsedText(secret, ctx)}</Quiet>
      </Section>
      {secret.kind._tag === "login" && (
        <Section title={t("secrets.sites")}>
          {secret.kind.origins.map((origin) => (
            <Text key={origin} selectable className="text-base text-foreground">
              {origin}
            </Text>
          ))}
        </Section>
      )}
      <Section title={t("secrets.values")}>
        {fieldsOf(secret).map((field) => (
          <ShownValue
            key={field}
            label={t(fieldLabel[field])}
            value={shown.values.get(field) ?? null}
            onShow={() => secrets.reveal(secret.id, field)}
            onShown={(value) => shown.show(field, value)}
            onHide={() => shown.hide(field)}
          />
        ))}
        {secret.kind._tag === "login" && secret.kind.hasTotp && (
          <CodeNow secret={secret} secrets={secrets} />
        )}
        {secret.lastReveal !== null && (
          <Quiet>{t("secrets.lastShown", { when: activityTime(secret.lastReveal.at, ctx) })}</Quiet>
        )}
      </Section>
      <AllowedBots secret={secret} secrets={secrets} />
      <Section>
        <Problem>{deleteFailure === null ? null : failureText(deleteFailure)}</Problem>
        <View className="flex-row flex-wrap justify-end gap-2">
          <DeleteButton
            label={t("secrets.delete")}
            title={t("secrets.deleteTitle", { name: secret.name })}
            body={t("secrets.deleteBody")}
            cancel={t("secrets.cancel")}
            onDelete={async () => {
              setDeleteFailure(null);
              const result = await secrets.remove(secret.id);
              if (result._tag === "done") onDeleted();
              else setDeleteFailure(result.failure);
            }}
          />
          <Button variant="secondary" label={t("secrets.edit")} onPress={onEdit} />
        </View>
      </Section>
    </>
  );
}

/**
 * The values shown on this screen, by field. Each goes 30 seconds after it
 * was shown; all go when the screen loses focus or the app leaves the
 * foreground, and a value that arrives after either is dropped.
 */
function useShownValues() {
  const [values, setValues] = useState<ReadonlyMap<SecretField, Redacted.Redacted<string>>>(
    new Map(),
  );
  const [shown] = useState(() => shownValues<SecretField>(setValues));
  useEffect(() => shown.hideAll, [shown]);
  const inView = useInView(shown.hideAll);
  return {
    values,
    hide: shown.hide,
    show: (field: SecretField, value: Redacted.Redacted<string>) => {
      if (inView()) shown.show(field, value);
    },
  };
}

/**
 * Whether the screen is in view with the app in the foreground, asked when
 * something to show arrives; `onLeave`, kept stable by the caller, runs when
 * the screen loses focus or the app leaves the foreground.
 */
function useInView(onLeave: () => void): () => boolean {
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        onLeave();
      };
    }, [onLeave]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") onLeave();
    });
    return () => subscription.remove();
  }, [onLeave]);
  return useCallback(() => focused.current && AppState.currentState === "active", []);
}

/**
 * A value of the secret: dots until Show, which asks the server for it; then
 * the value, Copy and Hide.
 */
function ShownValue({
  label,
  value,
  onShow,
  onShown,
  onHide,
}: {
  readonly label: string;
  readonly value: Redacted.Redacted<string> | null;
  readonly onShow: () => Promise<SecretsResult<Redacted.Redacted<string>>>;
  readonly onShown: (value: Redacted.Redacted<string>) => void;
  readonly onHide: () => void;
}) {
  const { t } = useI18n();
  const failureText = useSecretsFailureText();
  const { busy, failure, run } = useSecretsRequest();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const toggle = value === null ? t("secrets.show") : t("secrets.hide");
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text
          selectable={value !== null}
          className={`min-w-0 flex-1 font-mono text-base ${value === null ? "text-muted-foreground" : "text-foreground"}`}
        >
          {value === null ? "••••••••" : Redacted.value(value)}
        </Text>
        {value !== null && (
          <Button
            variant="quiet"
            label={copied ? t("secrets.copied") : t("secrets.copy")}
            accessibilityLabel={`${t("secrets.copy")}: ${label}`}
            onPress={() => void copySecret(Redacted.value(value)).then(setCopied)}
          />
        )}
        <Button
          variant="quiet"
          label={toggle}
          accessibilityLabel={`${toggle}: ${label}`}
          held={busy}
          onPress={() => (value === null ? run(onShow, onShown) : onHide())}
        />
      </View>
      <Problem>{failure === null ? null : failureText(failure)}</Problem>
    </View>
  );
}

/**
 * The login's one-time code now, to check it against the site's, until it is
 * no longer valid, the screen is left or the app leaves the foreground.
 */
function CodeNow({
  secret,
  secrets,
}: {
  readonly secret: Secret;
  readonly secrets: SecretsHandle;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const failureText = useSecretsFailureText();
  const { busy, failure, run } = useSecretsRequest();
  const [code, setCode] = useState<TotpPreview | null>(null);
  // Like the values, the code goes when the screen is left or the app is
  // backgrounded, and a code that arrives after either is dropped.
  const inView = useInView(useCallback(() => setCode(null), []));
  const valid = code !== null && DateTime.isLessThan(ctx.now, code.validUntil);
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{t("secrets.code")}</Text>
      {valid ? (
        <View className="min-h-11 flex-row items-center gap-3">
          <Text selectable className="font-mono text-xl tracking-widest text-foreground">
            {Redacted.value(code.code)}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t("secrets.codeUntil", { time: clockTime(code.validUntil, ctx) })}
          </Text>
        </View>
      ) : (
        <View className="flex-row">
          <Button
            variant="secondary"
            label={t("secrets.codeShow")}
            held={busy}
            onPress={() =>
              run(
                () => secrets.totpPreview(secret.id),
                (preview) => {
                  if (inView()) setCode(preview);
                },
              )
            }
          />
        </View>
      )}
      <Problem>{failure === null ? null : failureText(failure)}</Problem>
    </View>
  );
}

/** Which bots may use the secret, changed as soon as the operator flips one. */
function AllowedBots({
  secret,
  secrets,
}: {
  readonly secret: Secret;
  readonly secrets: SecretsHandle;
}) {
  const { t } = useI18n();
  const failureText = useSecretsFailureText();
  const { busy, failure, run } = useSecretsRequest();
  return (
    <Section title={t("secrets.bots")}>
      <AccessChoice
        access={secret.access}
        onChange={(access) => run(() => secrets.setAccess(secret.id, access))}
        readOnly={busy}
      />
      <Problem>{failure === null ? null : failureText(failure)}</Problem>
    </Section>
  );
}
