// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VaultFailure, VaultHandle, VaultResult } from "@j3-bots/client-runtime";
import { clockTime } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { activityTime } from "@j3-bots/client-runtime/wording";
import type { BotId, Credential, CredentialField, TotpPreview } from "@j3-bots/contracts";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DeleteButton, Problem, Quiet, Section, SwitchRow } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Body, Button, Centered } from "../ui.tsx";
import { useVaultFailureText, useVaultRequest, VaultGate } from "./VaultForms.tsx";

type Props = NativeStackScreenProps<Screens, "credential">;

/** How long a value shown stays on screen, in ms. */
const SHOWN_FOR = 30_000;

const fieldLabel = {
  username: "vault.field.username",
  password: "vault.field.password",
  totp: "vault.field.totp",
} as const;

/**
 * One saved login: its sites, its values hidden until asked for, its code
 * now, the bots that may use it, Edit and Delete. A value shown goes after
 * `SHOWN_FOR`, and at once when the screen is left, Edit included, or the app
 * goes to the background. The server records each time one is shown.
 */
export function CredentialScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const vault = useJ3Client().vault;
  const view = useReadable(vault.view);
  const unlocked = view._tag === "ready" && view.status.state === "unlocked" ? view : null;
  const credential = unlocked?.credentials?.find((found) => found.id === route.params.id) ?? null;
  const name = credential?.name ?? "";
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);
  if (unlocked === null) {
    return (
      <ScrollView className="flex-1 bg-background" keyboardShouldPersistTaps="handled">
        <Section>
          <VaultGate view={view} vault={vault} />
        </Section>
      </ScrollView>
    );
  }
  if (credential === null) {
    // Still being read, or deleted, here or from another device.
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
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <CredentialDetails
        credential={credential}
        vault={vault}
        onEdit={() => navigation.navigate("credentialForm", { id: credential.id })}
        onDeleted={navigation.goBack}
      />
    </ScrollView>
  );
}

function CredentialDetails({
  credential,
  vault,
  onEdit,
  onDeleted,
}: {
  readonly credential: Credential;
  readonly vault: VaultHandle;
  readonly onEdit: () => void;
  readonly onDeleted: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const failureText = useVaultFailureText();
  const shown = useShownValues();
  const [deleteFailure, setDeleteFailure] = useState<VaultFailure | null>(null);
  const fields: ReadonlyArray<CredentialField> = credential.hasTotp
    ? ["username", "password", "totp"]
    : ["username", "password"];
  return (
    <>
      <Section title={t("login.site")}>
        {credential.origins.map((origin) => (
          <Text key={origin} selectable className="text-base text-foreground">
            {origin}
          </Text>
        ))}
      </Section>
      <Section title={t("vault.values")}>
        {fields.map((field) => (
          <ShownValue
            key={field}
            label={t(fieldLabel[field])}
            value={shown.values.get(field) ?? null}
            onShow={() => vault.reveal(credential.id, field)}
            onShown={(value) => shown.show(field, value)}
            onHide={() => shown.hide(field)}
          />
        ))}
        {credential.hasTotp && <CodeNow credential={credential} vault={vault} />}
        {credential.lastReveal !== null && (
          <Quiet>
            {t("vault.lastShown", { when: activityTime(credential.lastReveal.at, ctx) })}
          </Quiet>
        )}
      </Section>
      <AllowedBots credential={credential} vault={vault} />
      <Section>
        <Problem>{deleteFailure === null ? null : failureText(deleteFailure)}</Problem>
        <View className="flex-row flex-wrap justify-end gap-2">
          <DeleteButton
            label={t("vault.delete")}
            title={t("vault.deleteTitle", { name: credential.name })}
            body={t("vault.deleteBody")}
            cancel={t("vault.cancel")}
            onDelete={async () => {
              setDeleteFailure(null);
              const result = await vault.remove(credential.id);
              if (result._tag === "done") onDeleted();
              else setDeleteFailure(result.failure);
            }}
          />
          <Button variant="secondary" label={t("vault.edit")} onPress={onEdit} />
        </View>
      </Section>
    </>
  );
}

/**
 * The values shown on this screen, by field. Each goes after `SHOWN_FOR`;
 * all go when the screen loses focus or the app leaves the foreground, and a
 * value that arrives after either is dropped.
 */
function useShownValues() {
  const [values, setValues] = useState<ReadonlyMap<CredentialField, Redacted.Redacted<string>>>(
    new Map(),
  );
  const timers = useRef(new Map<CredentialField, ReturnType<typeof setTimeout>>());
  const hide = useCallback((field: CredentialField) => {
    clearTimeout(timers.current.get(field));
    timers.current.delete(field);
    setValues((now) => {
      const next = new Map(now);
      next.delete(field);
      return next;
    });
  }, []);
  const hideAll = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setValues(new Map());
  }, []);
  const inView = useInView(hideAll);
  const show = (field: CredentialField, value: Redacted.Redacted<string>) => {
    if (!inView()) return;
    clearTimeout(timers.current.get(field));
    timers.current.set(
      field,
      setTimeout(() => hide(field), SHOWN_FOR),
    );
    setValues((now) => new Map(now).set(field, value));
  };
  return { values, show, hide };
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
 * A value of the login: dots until Show, which asks the server for it; then
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
  readonly onShow: () => Promise<VaultResult<Redacted.Redacted<string>>>;
  readonly onShown: (value: Redacted.Redacted<string>) => void;
  readonly onHide: () => void;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const { busy, failure, run } = useVaultRequest();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
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
            label={copied ? t("vault.copied") : t("vault.copy")}
            accessibilityLabel={`${t("vault.copy")}: ${label}`}
            onPress={() =>
              void Clipboard.setStringAsync(Redacted.value(value), {
                android: { isSensitive: true },
              }).then(() => setCopied(true))
            }
          />
        )}
        <Button
          variant="quiet"
          label={value === null ? t("vault.show") : t("vault.hide")}
          accessibilityLabel={`${value === null ? t("vault.show") : t("vault.hide")}: ${label}`}
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
  credential,
  vault,
}: {
  readonly credential: Credential;
  readonly vault: VaultHandle;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const failureText = useVaultFailureText();
  const { busy, failure, run } = useVaultRequest();
  const [code, setCode] = useState<TotpPreview | null>(null);
  // Like the values, the code goes when the screen is left or the app is
  // backgrounded, and a code that arrives after either is dropped.
  const inView = useInView(useCallback(() => setCode(null), []));
  const valid = code !== null && DateTime.isLessThan(ctx.now, code.validUntil);
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{t("vault.code")}</Text>
      {valid ? (
        <View className="min-h-11 flex-row items-center gap-3">
          <Text selectable className="font-mono text-xl tracking-widest text-foreground">
            {Redacted.value(code.code)}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t("vault.codeUntil", { time: clockTime(code.validUntil, ctx) })}
          </Text>
        </View>
      ) : (
        <View className="flex-row">
          <Button
            variant="secondary"
            label={t("vault.codeShow")}
            held={busy}
            onPress={() =>
              run(
                () => vault.totpPreview(credential.id),
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

/** Which bots may use the login: none until the operator allows one. */
function AllowedBots({
  credential,
  vault,
}: {
  readonly credential: Credential;
  readonly vault: VaultHandle;
}) {
  const { t } = useI18n();
  const bots = useBots();
  const failureText = useVaultFailureText();
  const { busy, failure, run } = useVaultRequest();
  if (bots.size === 0) return null;
  const allowed = new Set<BotId>(credential.allowedBots);
  const toggle = (botId: BotId, on: boolean) => {
    const next = on
      ? [...credential.allowedBots, botId]
      : credential.allowedBots.filter((id) => id !== botId);
    run(() => vault.setAllowedBots(credential.id, next));
  };
  return (
    <Section title={t("vault.bots")}>
      {[...bots.values()].map((bot) => (
        <SwitchRow
          key={bot.id}
          label={bot.profile.name}
          value={allowed.has(bot.id)}
          onChange={(on) => toggle(bot.id, on)}
          readOnly={busy}
        />
      ))}
      <Quiet>{t("vault.botsHint")}</Quiet>
      <Problem>{failure === null ? null : failureText(failure)}</Problem>
    </Section>
  );
}
