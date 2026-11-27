// SPDX-License-Identifier: AGPL-3.0-or-later
import { themePalettes } from "@j3-bots/client-runtime/presentation";
import type { ThemeDefinition } from "@j3-bots/contracts";
import { pictureVeil, themeColorVariables } from "@j3-bots/design-tokens";
import type { CSSProperties } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";

/**
 * A theme drawn small, in `appearance`: a list beside a short exchange and
 * the box to write in, in the theme's own colors whatever the page shows, so
 * themes are told apart by how they look. Its own CSS is the page's to show,
 * once it is applied. A picture, when given, sits behind the exchange under
 * the same veil as behind a conversation.
 */
export function ThemePreview({
  definition,
  appearance,
  picture = null,
  className,
}: {
  readonly definition: ThemeDefinition;
  readonly appearance: "light" | "dark";
  readonly picture?: string | null;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const palette = themePalettes(definition)[appearance];
  const style: CSSProperties & Readonly<Record<`--${string}`, string>> = {
    ...themeColorVariables(palette, appearance),
  };
  const veil = `color-mix(in oklab, var(--background) ${Math.round(pictureVeil(palette, appearance) * 100)}%, transparent)`;
  const backdrop: CSSProperties =
    picture === null
      ? {}
      : {
          backgroundImage: `linear-gradient(${veil}, ${veil}), url("${picture}")`,
          backgroundPosition: "center",
          backgroundSize: "cover",
        };
  return (
    <div
      aria-hidden
      style={style}
      className={cn(
        "flex h-24 overflow-hidden rounded-lg border border-border bg-background text-foreground",
        className,
      )}
    >
      <div className="flex w-1/4 shrink-0 flex-col gap-1 border-e border-border bg-sidebar p-1.5">
        <span className="h-2 rounded-sm bg-row-hover" />
        <span className="h-2 w-3/4 rounded-sm bg-muted" />
        <span className="h-2 w-2/3 rounded-sm bg-muted" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-end gap-1 p-1.5" style={backdrop}>
        <span className="max-w-[85%] self-start truncate rounded-md bg-bubble-bot px-1.5 py-0.5 text-2xs text-bubble-bot-foreground">
          {t("settings.themes.preview.bot")}
        </span>
        <span className="max-w-[85%] self-end truncate rounded-md bg-bubble-operator px-1.5 py-0.5 text-2xs text-bubble-operator-foreground">
          {t("settings.themes.preview.you")}
        </span>
        <span className="flex h-4 items-center rounded-md bg-muted px-1">
          <span className="ms-auto size-2 rounded-full bg-accent" />
        </span>
      </div>
    </div>
  );
}
