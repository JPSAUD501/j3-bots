// SPDX-License-Identifier: AGPL-3.0-or-later
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { SettingsPage } from "../presentation/settingsPages.ts";

const words: Record<SettingsPage, { readonly title: KeyWith; readonly description: KeyWith }> = {
  you: { title: "settings.you", description: "settings.you.description" },
  notifications: {
    title: "settings.notifications",
    description: "settings.notifications.description",
  },
  appearance: { title: "settings.appearance", description: "settings.appearance.description" },
  providers: { title: "settings.providers", description: "settings.providers.description" },
  usage: { title: "settings.usage", description: "settings.usage.description" },
  connectors: { title: "settings.connectors", description: "settings.connectors.description" },
  secrets: { title: "secrets.title", description: "settings.secrets.description" },
  devices: { title: "settings.devices", description: "settings.devices.description" },
  where: { title: "settings.where", description: "settings.where.description" },
  updates: { title: "settings.about", description: "settings.about.description" },
};

/** A Settings page's name, in its list and over it, and the line under that name. */
export const settingsPageWords = (
  page: SettingsPage,
  { t }: I18n,
): { readonly title: string; readonly description: string } => ({
  title: t(words[page].title),
  description: t(words[page].description),
});
