// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

export type Region = "roster" | "conversation" | "details";

interface AppShellProps {
  readonly roster: ReactNode;
  readonly conversation: ReactNode;
  /** Null when the details are closed. */
  readonly details: ReactNode | null;
  /** The region a phone shows; wider layouts show several at once. */
  readonly active: Region;
  readonly onCloseDetails: () => void;
}

/**
 * The three regions. The layout follows the shell's own width, not the
 * window's: one region at a time below `tablet`; roster and conversation side
 * by side from `tablet`, with the details over the conversation; all three
 * side by side from `wide`.
 */
export function AppShell({ roster, conversation, details, active, onCloseDetails }: AppShellProps) {
  return (
    <div className="@container h-full w-full">
      <div className="relative flex h-full w-full overflow-hidden bg-background">
        <aside
          data-active={active === "roster" ? "" : undefined}
          className="hidden w-full shrink-0 flex-col border-border bg-sidebar data-active:flex @tablet:flex @tablet:w-(--layout-roster-width) @tablet:border-e"
        >
          {roster}
        </aside>
        <main
          data-active={active === "conversation" ? "" : undefined}
          className="hidden min-w-0 flex-1 flex-col data-active:flex @tablet:flex"
        >
          {conversation}
        </main>
        {details !== null && (
          <>
            {/* Between tablet and wide the pane lies over the conversation; clicking beside it closes it. */}
            <div
              aria-hidden
              onClick={onCloseDetails}
              className="absolute inset-0 z-10 hidden bg-scrim @tablet:block @wide:hidden"
            />
            <aside
              data-active={active === "details" ? "" : undefined}
              className="absolute inset-0 z-20 hidden flex-col bg-background data-active:flex @tablet:start-auto @tablet:flex @tablet:w-(--layout-details-width) @tablet:border-s @tablet:shadow-xl @wide:static @wide:shadow-none"
            >
              {details}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
