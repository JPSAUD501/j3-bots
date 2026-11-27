// SPDX-License-Identifier: AGPL-3.0-or-later
import { LockIcon } from "lucide-react";

/**
 * Where the composer would be, in a conversation the operator reads and
 * writes nothing in: two bots' messages, or a room of bots only.
 */
export function ReadOnlyMark({ label }: { readonly label: string }) {
  return (
    <div className="flex justify-center px-3 pt-1 pb-[max(--spacing(3),env(safe-area-inset-bottom))]">
      <p className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3.5 py-2 text-xs text-muted-foreground">
        <LockIcon aria-hidden className="size-3.5" />
        {label}
      </p>
    </div>
  );
}
