// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import { knownTimeZone } from "@j3-bots/client-runtime/presentation";
import {
  useJ3Client,
  useProfileEdits,
  useProfileForm,
  useReadable,
  useSettings,
} from "@j3-bots/client-runtime/react";
import type { NotificationSettingsChange, Settings } from "@j3-bots/contracts";
import { getCalendars } from "expo-localization";
import { useState } from "react";
import { Text, View } from "react-native";
import { Problem, Quiet, Section, SwitchRow, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { Button } from "../ui.tsx";

/** What bots call the operator, and the time zone routines and times follow. */
export function YouSection(props: { readonly connected: boolean }) {
  const { t } = useI18n();
  const settings = useSettings();
  return (
    <Section title={t("settings.you")}>
      {settings._tag !== "ready" ? (
        <Quiet>{t("details.loading")}</Quiet>
      ) : (
        <YouForm settings={settings.value} connected={props.connected} />
      )}
    </Section>
  );
}

/**
 * Saving needs the server: offline, Save says why it is unavailable. A save
 * sends only the fields the operator changed. While the form's save is under
 * way the form shows what it sends and takes no edit. A field the operator
 * left alone shows the saved value as it arrives; one they changed keeps
 * their edit until the form saves it. The zone is typed as the system names
 * it, in any case, and checked once the operator leaves the field or saves;
 * this phone's own is one press away.
 */
function YouForm(props: { readonly settings: Settings; readonly connected: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const save: SettingsSaves["profile"] = useReadable(client.settingsSaves.profile);
  const { settings, connected } = props;
  const profile = useProfileEdits(save);
  const form = useProfileForm({ settings, save, profile, connected });
  const deviceZone = getCalendars()[0]?.timeZone ?? null;
  const phoneZone = deviceZone === null ? null : knownTimeZone(deviceZone);
  return (
    <View className="gap-4">
      <TextField
        label={t("settings.name")}
        value={form.name}
        maxLength={200}
        placeholder={t("settings.name.placeholder")}
        readOnly={form.saving}
        autoCapitalize="words"
        onChange={form.editName}
      />
      <View className="gap-2">
        <TextField
          label={t("settings.timeZone")}
          value={form.zone}
          readOnly={form.saving}
          autoCapitalize="none"
          hint={t("settings.timeZone.hint")}
          error={form.zoneUnknown ? t("settings.timeZone.invalid") : null}
          onChange={form.editZone}
          onBlur={form.checkZone}
        />
        {phoneZone !== null && phoneZone !== form.zone && (
          <View className="items-start">
            <Button
              label={t("settings.timeZone.usePhone", { zone: phoneZone.replaceAll("_", " ") })}
              disabled={form.saving}
              onPress={() => form.editZone(phoneZone)}
            />
          </View>
        )}
      </View>
      <View className="flex-row flex-wrap items-center gap-3">
        <Button
          variant="primary"
          label={t("settings.save")}
          disabled={!form.canSave}
          onPress={() =>
            form.submit((changes) => void client.updateSettings({ section: "profile", changes }))
          }
        />
        {form.status === "saved" && (
          <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
            {t("settings.saved")}
          </Text>
        )}
        <Problem>{form.status === "failed" ? t("settings.saveFailed") : null}</Problem>
      </View>
      {!connected && <Quiet>{t("settings.save.offline")}</Quiet>}
    </View>
  );
}

/** Whether this phone shows notifications: not asked yet, allowed, or refused. */
type PhoneNotificationAccess = "default" | "granted" | "denied";

/** What this phone does about notifications, in words, once it was asked. */
const accessLine = {
  granted: "settings.notifications.phone.granted",
  denied: "settings.notifications.phone.denied",
} as const satisfies Record<Exclude<PhoneNotificationAccess, "default">, string>;

/**
 * Whether J3 Bots notifies the operator and how much a notification says,
 * which hold for every device. A switch saves at once; offline, or while a
 * switch's save is under way, it shows the value it holds and takes no
 * change. How a save ended shows only for one this section saw under way.
 */
export function NotificationsSection(props: {
  readonly connected: boolean;
  /**
   * Whether this phone shows notifications, and what asks to allow them and
   * then registers the phone with the server. Absent until this build can
   * receive pushes.
   */
  readonly thisPhone?: {
    readonly access: PhoneNotificationAccess;
    readonly allow: () => void;
  };
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const settings = useSettings();
  const save: SettingsSaves["notifications"] = useReadable(client.settingsSaves.notifications);
  const saving = save._tag === "saving";
  const [watching, setWatching] = useState(saving);
  if (settings._tag !== "ready") {
    return (
      <Section title={t("settings.notifications")}>
        <Quiet>{t("details.loading")}</Quiet>
      </Section>
    );
  }
  const shown = { ...settings.value.notifications, ...(saving ? save.changes : undefined) };
  const readOnly = saving || !props.connected;
  // Only the switch that changed: another device may have changed the other one.
  const change = (changes: NotificationSettingsChange) => {
    if (readOnly) return;
    setWatching(true);
    void client.updateSettings({ section: "notifications", changes });
  };
  return (
    <Section title={t("settings.notifications")}>
      <SwitchRow
        label={t("settings.notifications.enabled")}
        hint={t("settings.notifications.enabled.hint")}
        value={shown.enabled}
        readOnly={readOnly}
        onChange={(enabled) => change({ enabled })}
      />
      {shown.enabled && (
        <>
          {props.thisPhone !== undefined &&
            (props.thisPhone.access === "default" ? (
              <View className="items-start gap-1.5">
                <Quiet>{t("settings.notifications.phone.default")}</Quiet>
                <Button
                  label={t("settings.notifications.allowPhone")}
                  onPress={props.thisPhone.allow}
                />
              </View>
            ) : (
              <Quiet>{t(accessLine[props.thisPhone.access])}</Quiet>
            ))}
          <SwitchRow
            label={t("settings.notifications.previews")}
            hint={t("settings.notifications.previews.hint")}
            value={shown.previews}
            readOnly={readOnly}
            onChange={(previews) => change({ previews })}
          />
        </>
      )}
      <Problem>{watching && save._tag === "failed" ? t("settings.saveFailed") : null}</Problem>
      {!props.connected && <Quiet>{t("settings.save.offline")}</Quiet>}
    </Section>
  );
}
