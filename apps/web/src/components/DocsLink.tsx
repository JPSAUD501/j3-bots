// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** A link to a page of the docs, which opens outside the app. */
export function DocsLink({
  href,
  children,
  className,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-0.5 text-xs underline underline-offset-2",
        className,
      )}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}
