// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import { usageDataSwitch } from "@j3-bots/client-runtime/presentation";
import type { Settings } from "@j3-bots/contracts";
import { useI18n } from "../app/context";
import type { DiagnosticsIntents, ShellIntents } from "../shell/data";
import { DiagnosticsRow } from "./Diagnostics";
import { UsageDataRow } from "./UsageData";

/**
 * The About page's privacy area: what leaves the server about how it runs,
 * together. The switch for usage data, which the server sends on its own, and
 * the diagnostics zip, which the operator sends where they choose. Each where
 * the server offers it; nothing where it offers neither.
 */
export function PrivacySection({
  settings,
  save,
  connected,
  intents,
  diagnostics,
}: {
  settings: Settings | null;
  save: SettingsSaves["usage-data"];
  connected: boolean;
  intents: Pick<ShellIntents, "updateSettings" | "usageData">;
  diagnostics: DiagnosticsIntents | undefined;
}) {
  const { t } = useI18n();
  const usageData = usageDataSwitch(settings, save);
  if (usageData === null && diagnostics === undefined) return null;
  return (
    <section className="flex flex-col gap-4">
      <h4 className="text-xs font-medium">{t("about.privacy")}</h4>
      {usageData !== null && (
        <UsageDataRow view={usageData} connected={connected} intents={intents} />
      )}
      {diagnostics !== undefined && <DiagnosticsRow diagnostics={diagnostics} />}
    </section>
  );
}
