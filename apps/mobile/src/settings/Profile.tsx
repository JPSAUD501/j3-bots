// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import {
  editsAfterFailedSave,
  knownTimeZone,
  noEdits,
  settingsPatch,
  type SettingsEdits,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable, useSettings } from "@j3-bots/client-runtime/react";
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
 * their edit until the form saves it. The zone is written as the system
 * names it; this phone's own is one press away.
 */
function YouForm(props: { readonly settings: Settings; readonly connected: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const save: SettingsSaves["profile"] = useReadable(client.settingsSaves.profile);
  const { settings, connected } = props;
  const [edits, setEdits] = useState<SettingsEdits>(() =>
    save._tag === "failed" ? editsAfterFailedSave(noEdits, save.changes) : noEdits,
  );
  const [lastSave, setLastSave] = useState(save);
  if (lastSave !== save) {
    setLastSave(save);
    if (save._tag === "saved") setEdits(noEdits);
    if (save._tag === "failed") setEdits((current) => editsAfterFailedSave(current, save.changes));
  }
  // How a save ended shows only for one this form saw under way, until the next edit.
  const [watching, setWatching] = useState(save._tag === "saving");
  const saving = save._tag === "saving";
  const sending = saving ? save.changes : null;
  const name =
    edits.name ??
    (sending?.operatorName === undefined ? settings.operatorName : sending.operatorName) ??
    "";
  const zone = edits.zone ?? sending?.timeZone ?? settings.timeZone;
  const phoneZone = getCalendars()[0]?.timeZone ?? null;
  const patch = settingsPatch(settings, edits);
  const zoneUnknown = edits.zone !== null && knownTimeZone(edits.zone) === null;
  const status = watching && !saving ? save._tag : null;
  const edit = (change: Partial<SettingsEdits>) => {
    if (saving) return;
    setEdits((current) => ({ ...current, ...change }));
    setWatching(false);
  };
  return (
    <View className="gap-4">
      <TextField
        label={t("settings.name")}
        value={name}
        maxLength={200}
        placeholder={t("settings.name.placeholder")}
        readOnly={saving}
        autoCapitalize="words"
        onChange={(value) => edit({ name: value })}
      />
      <View className="gap-2">
        <TextField
          label={t("settings.timeZone")}
          value={zone}
          readOnly={saving}
          autoCapitalize="none"
          hint={t("settings.timeZone.hint")}
          error={zoneUnknown ? t("settings.timeZone.invalid") : null}
          onChange={(value) => edit({ zone: value })}
        />
        {phoneZone !== null && phoneZone !== zone && knownTimeZone(phoneZone) !== null && (
          <View className="items-start">
            <Button
              label={t("settings.timeZone.usePhone", { zone: phoneZone.replaceAll("_", " ") })}
              disabled={saving}
              onPress={() => edit({ zone: phoneZone })}
            />
          </View>
        )}
      </View>
      <View className="flex-row flex-wrap items-center gap-3">
        <Button
          variant="primary"
          label={t("settings.save")}
          disabled={patch._tag !== "changes" || saving || !connected}
          onPress={() => {
            if (patch._tag !== "changes" || saving || !connected) return;
            setWatching(true);
            void client.updateSettings({ section: "profile", changes: patch.changes });
          }}
        />
        {status === "saved" && (
          <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
            {t("settings.saved")}
          </Text>
        )}
        <Problem>{status === "failed" ? t("settings.saveFailed") : null}</Problem>
      </View>
      {!connected && <Quiet>{t("settings.save.offline")}</Quiet>}
    </View>
  );
}

/**
 * Whether J3 Bots notifies the operator and how much a notification says,
 * which hold for every device. A switch saves at once; offline, or while a
 * switch's save is under way, it shows the value it holds and takes no
 * change. How a save ended shows only for one this section saw under way.
 */
export function NotificationsSection(props: {
  readonly connected: boolean;
  /**
   * Asks to allow notifications on this phone, then registers it with the
   * server. Absent until this build can receive pushes.
   */
  readonly allowOnThisPhone?: () => void;
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
          {props.allowOnThisPhone !== undefined && (
            <View className="items-start">
              <Button
                label={t("settings.notifications.allowPhone")}
                onPress={props.allowOnThisPhone}
              />
            </View>
          )}
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
