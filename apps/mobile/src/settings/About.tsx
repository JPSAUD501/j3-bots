// SPDX-License-Identifier: AGPL-3.0-or-later
import { Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { PhoneUpdatePanel, ServerUpdatePanel } from "../update/UpdatePanels.tsx";
import { UsageDataSection } from "./UsageData.tsx";

/**
 * The versions the server and this app run, and their updates: the server's,
 * which this phone starts and follows, then the app's own, each with its
 * channel. Then the server's switch for usage data, where it offers one.
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
      <UsageDataSection connected={connected} />
    </>
  );
}
