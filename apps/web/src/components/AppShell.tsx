// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { useState, type ReactNode, type Ref, type RefObject } from "react";
import type { ShellLayout } from "../shell/layout";

export type Region = "roster" | "conversation" | "details";

interface AppShellProps {
  readonly roster: ReactNode;
  readonly conversation: ReactNode;
  /** Null when the details are closed. */
  readonly details: ReactNode | null;
  /** The id of the details' heading, which names the pane. */
  readonly detailsHeadingId: string;
  /** Where focus goes when the details open as a dialog. */
  readonly detailsHeadingRef: RefObject<HTMLHeadingElement | null>;
  /** Where focus returns when that dialog closes: the conversation's title. */
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  /** The region a phone shows; wider layouts show several at once. */
  readonly active: Region;
  /** As measured on `containerRef`; null before the first measure. */
  readonly layout: ShellLayout | null;
  readonly containerRef: Ref<HTMLDivElement>;
  readonly onCloseDetails: () => void;
}

/**
 * The three regions. The layout follows the shell's own width, not the
 * window's: one region at a time below `tablet`; roster and conversation side
 * by side from `tablet`, with the details over the conversation as a modal
 * dialog; all three side by side from `wide`, where the details are an
 * ordinary region. Each region keeps clear of the screen's safe-area insets
 * on the edges it touches.
 */
export function AppShell({
  roster,
  conversation,
  details,
  detailsHeadingId,
  detailsHeadingRef,
  returnFocusRef,
  active,
  layout,
  containerRef,
  onCloseDetails,
}: AppShellProps) {
  // The dialog is drawn inside the shell, so it lies over the shell and not over the page around it.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const modal = layout === "phone" || layout === "tablet";
  const covered = details !== null && modal;
  return (
    <div ref={containerRef} className="@container h-full w-full">
      <div ref={setFrame} className="relative flex h-full w-full overflow-hidden bg-background">
        <aside
          data-active={active === "roster" ? "" : undefined}
          inert={covered}
          className="hidden w-full shrink-0 flex-col border-border bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] data-active:flex @max-tablet:pr-[env(safe-area-inset-right)] @tablet:flex @tablet:w-(--layout-roster-width) @tablet:border-e"
        >
          {roster}
        </aside>
        <main
          data-active={active === "conversation" ? "" : undefined}
          inert={covered}
          className="hidden min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] data-active:flex @max-tablet:pl-[env(safe-area-inset-left)] @tablet:flex"
        >
          {conversation}
        </main>
        {details !== null && layout === "wide" && (
          <aside
            aria-labelledby={detailsHeadingId}
            className="flex w-(--layout-details-width) shrink-0 flex-col border-s border-border bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]"
          >
            {details}
          </aside>
        )}
        <Dialog.Root
          open={details !== null && modal}
          onOpenChange={(open) => {
            if (!open) onCloseDetails();
          }}
        >
          <Dialog.Portal container={frame}>
            {/* Beside the pane, the scrim closes it; a phone's pane covers everything. */}
            <Dialog.Backdrop className="absolute inset-0 z-10 hidden bg-scrim @tablet:block" />
            <Dialog.Popup
              aria-labelledby={detailsHeadingId}
              aria-modal
              initialFocus={detailsHeadingRef}
              finalFocus={returnFocusRef}
              className="absolute inset-0 z-20 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] outline-none @max-tablet:pl-[env(safe-area-inset-left)] @tablet:start-auto @tablet:w-(--layout-details-width) @tablet:border-s @tablet:border-border @tablet:shadow-xl"
            >
              {details}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </div>
  );
}
