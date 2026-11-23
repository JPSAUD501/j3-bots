// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { useI18n } from "../app/context";

/** One section of Settings, under a quiet heading. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * What a section shows until its first read answers: the shape of a row or
 * two, about as tall as what replaces it. Screen readers hear "Loading…".
 */
export function Loading() {
  const { t } = useI18n();
  return (
    <div role="status" className="flex flex-col gap-2">
      <span className="sr-only">{t("details.loading")}</span>
      <span aria-hidden className="skeleton h-10 w-full rounded-md" />
      <span aria-hidden className="skeleton h-10 w-full rounded-md" />
    </div>
  );
}
