// SPDX-License-Identifier: AGPL-3.0-or-later
import { themeOffer, themePalettes } from "@j3-bots/client-runtime/presentation";
import type { ThemeId } from "@j3-bots/contracts";
import { CheckIcon, PaletteIcon } from "lucide-react";
import { useI18n } from "../app/context";
import { setThemeId, usePreferences } from "../preferences/preferences";
import { useShownThemes } from "../themes/ThemeRuntime";
import { Button } from "./ui/button";

/**
 * A bot's offer of a theme, under its message (decision 0104): saving a theme
 * never shows it, so the person applies it here, to this device. Once it
 * shows, a quiet line says so; a theme deleted since says that instead. Where
 * the shell knows no themes, or before a saved one's library arrives, it
 * shows nothing.
 */
export function ApplyThemeOffer({ themeId }: { readonly themeId: ThemeId }) {
  const { t } = useI18n();
  const { theme: appearance } = usePreferences();
  const themes = useShownThemes();
  if (themes === null) return null;
  const offer = themeOffer(themeId, themes.themes.library, themes.themes.known, themes.shown);
  if (offer._tag === "waiting") return null;
  if (offer._tag === "gone") {
    return (
      <p className="max-w-(--layout-bubble-width) ps-1 text-xs text-muted-foreground">
        {t("message.offer.applyTheme.gone")}
      </p>
    );
  }
  if (offer._tag === "in-use") {
    return (
      <p className="flex max-w-(--layout-bubble-width) items-center gap-1.5 ps-1 text-xs text-muted-foreground">
        <CheckIcon aria-hidden className="size-3.5 shrink-0" />
        {t("message.offer.applyTheme.inUse")}
      </p>
    );
  }
  const { choice } = offer;
  const palette = themePalettes(choice.definition)[appearance];
  return (
    <Button variant="outline" size="sm" onClick={() => setThemeId(choice.id)}>
      <PaletteIcon aria-hidden />
      {t("message.offer.applyTheme")}
      {/* The theme's own canvas and accent, so it is seen before it is applied. */}
      <span
        aria-hidden
        className="ms-0.5 flex size-3.5 overflow-hidden rounded-full border border-border"
      >
        <span className="flex-1" style={{ background: palette.background }} />
        <span className="flex-1" style={{ background: palette.accent }} />
      </span>
    </Button>
  );
}
