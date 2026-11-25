// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * A group of settings on a page of Settings, set apart from the next by space,
 * under a quiet heading when the page's own title does not name it. An
 * `apart` group, one whose action cannot be undone, is ruled off below the rest.
 */
export function Section({
  title,
  apart = false,
  children,
}: {
  title?: string;
  apart?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3", apart && "border-t border-border pt-6")}>
      {title !== undefined && (
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      )}
      {children}
    </section>
  );
}
