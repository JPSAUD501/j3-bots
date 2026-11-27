// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A link to a page of the docs, which opens outside the app. */
export function DocsLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-xs underline underline-offset-2"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}
