// SPDX-License-Identifier: AGPL-3.0-or-later
import { Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { PhoneUpdatePanel, ServerUpdatePanel } from "../update/UpdatePanels.tsx";
import { DiagnosticsSection } from "./Diagnostics.tsx";

/**
 * The versions the server and this app run, and their updates: the server's,
 * which this phone starts and follows, then the app's own, each with its
 * channel. Last, the server's diagnostics zip, from a server that makes one.
 */
export function AboutSection() {
  const { t } = useI18n();
  return (
    <>
      <Section open title={t("about.server")}>
        <ServerUpdatePanel place="settings" />
      </Section>
      <Section open title={t("about.thisApp")}>
        <PhoneUpdatePanel place="settings" />
      </Section>
      <DiagnosticsSection />
    </>
  );
}
