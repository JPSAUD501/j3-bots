// SPDX-License-Identifier: AGPL-3.0-or-later
import { StarIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../app/context";

/**
 * The primary bot's mark: a small `accent` disc with a star, at the avatar's
 * lower right, ringed in what the avatar sits on (`--avatar-cutout`) so it
 * stands clear of the body. It marks a role, never a state: the antenna's
 * light still carries what the bot is doing. Assistive technology hears
 * "Primary bot" with the bot's name, unless `labelled` says the text beside
 * it says so already.
 */
export function PrimaryBadge({
  primary,
  size,
  children,
  labelled = false,
}: {
  readonly primary: boolean;
  /** The avatar's size in px: the mark is drawn in proportion, never under 14 px. */
  readonly size: number;
  readonly children: ReactNode;
  readonly labelled?: boolean;
}) {
  const { t } = useI18n();
  if (!primary) return children;
  const mark = Math.max(14, Math.round(size * 0.36));
  const ring = Math.max(2, Math.round(mark / 8));
  return (
    <span className="relative inline-flex shrink-0">
      {children}
      <span
        className="absolute flex items-center justify-center rounded-pill bg-accent text-accent-foreground"
        style={{
          width: mark,
          height: mark,
          right: -ring,
          bottom: -ring,
          boxShadow: `0 0 0 ${ring}px var(--avatar-cutout, var(--background))`,
        }}
      >
        <StarIcon
          aria-hidden
          fill="currentColor"
          strokeWidth={0}
          style={{ width: mark * 0.62, height: mark * 0.62 }}
        />
        {!labelled && <span className="sr-only">{t("roster.primary")}</span>}
      </span>
    </span>
  );
}
