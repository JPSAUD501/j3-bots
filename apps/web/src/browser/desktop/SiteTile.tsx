// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from "../../lib/cn";
import { siteLetter } from "./state";

/** A site's letter, where its icon would be. */
export function SiteTile({
  url,
  title,
  className,
}: {
  readonly url: string;
  readonly title: string;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-2xs font-semibold text-muted-foreground",
        className,
      )}
    >
      {siteLetter(url, title)}
    </span>
  );
}
