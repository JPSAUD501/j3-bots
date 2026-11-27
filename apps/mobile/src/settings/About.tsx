// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import { usageDataSwitch } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable, useSettings } from "@j3-bots/client-runtime/react";
import { Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { PhoneUpdatePanel, ServerUpdatePanel } from "../update/UpdatePanels.tsx";
import { DiagnosticsRow } from "./Diagnostics.tsx";
import { UsageDataRow } from "./UsageData.tsx";

/**
 * The versions the server and this app run, and their updates: the server's,
 * which this phone starts and follows, then the app's own, each with its
 * channel. Then privacy, as far as the server offers it.
 */
export function AboutSection({ connected }: { readonly connected: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <Section open title={t("about.server")}>
        <ServerUpdatePanel place="settings" />
      </Section>
      <Section open title={t("about.thisApp")}>
        <PhoneUpdatePanel place="settings" />
      </Section>
      <PrivacySection connected={connected} />
    </>
  );
}

/**
 * What leaves the server about how it runs, together: the switch for usage
 * data, which it sends on its own, and the diagnostics zip, which the
 * operator sends where they choose. Each where the server offers it.
 */
function PrivacySection({ connected }: { readonly connected: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const server = useReadable(client.server);
  const settings = useSettings();
  const save: SettingsSaves["usage-data"] = useReadable(client.settingsSaves["usage-data"]);
  const usageData = usageDataSwitch(settings._tag === "ready" ? settings.value : null, save);
  const diagnostics = server?.diagnostics !== undefined;
  if (usageData === null && !diagnostics) return null;
  return (
    <Section open title={t("about.privacy")}>
      {usageData !== null && <UsageDataRow view={usageData} connected={connected} />}
      {diagnostics && <DiagnosticsRow />}
    </Section>
  );
}
