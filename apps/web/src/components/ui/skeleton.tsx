// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "../../app/context";

/**
 * The shape of rows still loading, as tall as the rows that replace them, so
 * nothing shifts while they are read: a mark and two lines per row, as on
 * Android. They show only after a moment and breathe slowly (`skeleton`);
 * reduced motion keeps them still. Screen readers hear "Loading…".
 */
export function SkeletonRows({ count = 2 }: { count?: number }) {
  const { t } = useI18n();
  return (
    <div role="status" className="flex flex-col">
      <span className="sr-only">{t("details.loading")}</span>
      {Array.from({ length: count }, (_, row) => (
        <span key={row} aria-hidden className="flex items-center gap-3 py-2.5">
          <span className="skeleton size-4 shrink-0" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="skeleton h-3 w-2/3" />
            <span className="skeleton h-2.5 w-1/3" />
          </span>
        </span>
      ))}
    </div>
  );
}
