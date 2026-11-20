// SPDX-License-Identifier: AGPL-3.0-or-later
import { SettingsIcon } from "lucide-react";
import { useI18n } from "../app/context";
import {
  setAppearance,
  setLanguage,
  usePreferences,
  type Appearance,
  type Language,
} from "../preferences/preferences";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuSeparator, MenuTrigger } from "./ui/menu";

/** The roster's footer: appearance and language for this browser. */
export function SettingsMenu() {
  const { t } = useI18n();
  const { appearance, language } = usePreferences();
  const appearances: ReadonlyArray<{ value: Appearance; label: string }> = [
    { value: "system", label: t("settings.system") },
    { value: "light", label: t("settings.light") },
    { value: "dark", label: t("settings.dark") },
  ];
  // Each language is named in itself, so it can be found from any other.
  const languages: ReadonlyArray<{ value: Language; label: string }> = [
    { value: "system", label: t("settings.system") },
    { value: "en", label: "English" },
    { value: "pt-BR", label: "Português (Brasil)" },
  ];
  return (
    <div className="border-t border-border p-2">
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" className="w-full justify-start px-2" />}
        >
          <SettingsIcon aria-hidden />
          {t("settings.title")}
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuGroup label={t("settings.appearance")}>
            <MenuRadioGroup
              value={appearance}
              onValueChange={setAppearance}
              options={appearances}
            />
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup label={t("settings.language")}>
            <MenuRadioGroup value={language} onValueChange={setLanguage} options={languages} />
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
