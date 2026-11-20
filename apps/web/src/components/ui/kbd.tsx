// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-4.5 min-w-4.5 select-none items-center justify-center rounded-sm bg-code-background px-1 font-sans text-2xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
