// SPDX-License-Identifier: AGPL-3.0-or-later
import { siteOf } from "@j3-bots/client-runtime/presentation";
import { GlobeIcon } from "lucide-react";
import { useI18n } from "../app/context";

/**
 * What stands in a tab's picture while there is none of the page it is on:
 * the page's title and its site, calm and centered, never an empty box. It
 * is the card's to name the tab to assistive technology, so this is hidden.
 */
export function TabPlaceholder({ title, url }: { readonly title: string; readonly url: string }) {
  const { t } = useI18n();
  const site = siteOf(url);
  const name = title.trim() === "" ? site || t("browser.panel.newTab") : title;
  return (
    <span
      aria-hidden
      className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted px-3 text-center"
    >
      <GlobeIcon className="size-5 text-muted-foreground" />
      <span className="line-clamp-2 text-sm font-medium text-foreground">{name}</span>
      {site !== "" && site !== name && (
        <span className="max-w-full truncate text-2xs text-muted-foreground">{site}</span>
      )}
    </span>
  );
}
