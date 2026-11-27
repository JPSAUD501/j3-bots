// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";
import { deferred } from "../lib/deferred";
import { BROWSER_MIN, CONVERSATION_MIN, storedBrowserWidth } from "../shell/browserWidth";
import { useKeptWhileLeaving } from "../lib/useKeptWhileLeaving";
import type { ShellLayout } from "../shell/layout";

export type Region = "roster" | "conversation" | "details";

/** Only once a browser is open beside the conversation: not part of the app's first load. */
const Divider = deferred(() =>
  import("./PaneDivider").then((divider) => divider.PaneDivider),
).Component;

interface AppShellProps {
  readonly roster: ReactNode;
  readonly conversation: ReactNode;
  /** Null when the details are closed. */
  readonly details: ReactNode | null;
  /** What `details` holds: the details, or a bot's browser, which takes more room. */
  readonly asideKind: "details" | "browser";
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
  /** The conversation's region, for what lies over it. */
  readonly conversationRef: Ref<HTMLElement>;
  readonly onCloseDetails: () => void;
  /** The browser beside the conversation is being resized, and so moves under the pointer. */
  readonly onBrowserResizing?: ((resizing: boolean) => void) | undefined;
}

/**
 * The three regions. The layout follows the shell's own width, not the
 * window's: one region at a time below `tablet`; roster and conversation side
 * by side from `tablet`, with the details over the conversation as a modal
 * dialog; all three side by side from `wide`, where the details are an
 * ordinary region. Each region keeps clear of the screen's safe-area insets
 * on the edges it touches. The details slide in from the end on `slide`, beside
 * the conversation or over it, and slide back out on the quicker `out` ease,
 * keeping what they showed until they are gone.
 */
export function AppShell({
  roster,
  conversation,
  details,
  asideKind,
  detailsHeadingId,
  detailsHeadingRef,
  returnFocusRef,
  active,
  layout,
  containerRef,
  conversationRef,
  onCloseDetails,
  onBrowserResizing,
}: AppShellProps) {
  // The dialog is drawn inside the shell, so it lies over the shell and not over the page around it.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const modal = layout === "phone" || layout === "tablet";
  const covered = details !== null && modal;
  const pane = useKeptWhileLeaving(details);
  // The kind of what leaves stays with it, so it leaves as it came.
  const [keptKind, setKeptKind] = useState(asideKind);
  if (details !== null && keptKind !== asideKind) setKeptKind(asideKind);
  const browser = (details === null ? keptKind : asideKind) === "browser";
  const rosterRef = useRef<HTMLElement>(null);
  // Beside the conversation the browser takes what room the conversation can spare, or as wide
  // as the person left it.
  const [wanted, setWanted] = useState(storedBrowserWidth);
  const paneWidth = browser ? "w-(--browser-width)" : "w-(--layout-details-width)";
  const browserWidth =
    wanted === null
      ? "clamp(25rem, calc(100cqw - var(--layout-roster-width) - 28rem), 60rem)"
      : `clamp(${BROWSER_MIN}px, ${wanted}px, calc(100cqw - var(--layout-roster-width) - ${CONVERSATION_MIN}px))`;
  const browserStyle: CSSProperties & Record<"--browser-width", string> = {
    "--browser-width": browserWidth,
  };
  return (
    <div ref={containerRef} className="@container h-full w-full">
      <div ref={setFrame} className="relative flex h-full w-full overflow-hidden bg-background">
        <aside
          ref={rosterRef}
          data-active={active === "roster" ? "" : undefined}
          inert={covered}
          className="hidden w-full shrink-0 flex-col border-border bg-sidebar pt-(--inset-top) pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] data-active:flex @max-tablet:pr-[env(safe-area-inset-right)] @tablet:flex @tablet:w-(--layout-roster-width) @tablet:border-e"
        >
          {roster}
        </aside>
        <main
          ref={conversationRef}
          data-slot="conversation"
          data-active={active === "conversation" ? "" : undefined}
          inert={covered}
          className="hidden min-w-0 flex-1 flex-col pt-(--inset-top) pr-[env(safe-area-inset-right)] data-active:flex @max-tablet:pl-[env(safe-area-inset-left)] @tablet:flex"
        >
          {conversation}
        </main>
        {pane.shown !== null && layout === "wide" && browser && frame !== null && (
          <Divider
            frame={frame}
            roster={rosterRef}
            wanted={wanted}
            onWanted={setWanted}
            onResizing={onBrowserResizing}
            onClose={onCloseDetails}
          />
        )}
        {pane.shown !== null && layout === "wide" && (
          <aside
            aria-labelledby={detailsHeadingId}
            inert={pane.leaving}
            style={browser ? browserStyle : undefined}
            className={cn("flex shrink-0 overflow-hidden", paneWidth)}
          >
            {/*
             * The pane takes its room at once, so the conversation is laid out
             * once as it opens and once after it closes, and the details slide
             * in and out over that room with a transform, never resizing it.
             */}
            <div
              data-leaving={pane.leaving ? "" : undefined}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget && pane.leaving) pane.gone();
              }}
              className={cn(
                paneWidth,
                "flex shrink-0 animate-[pane-in_var(--duration-slide)_var(--ease-slide)] flex-col border-s border-border bg-background pt-(--inset-top) pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] [--pane-from:100%] rtl:[--pane-from:-100%] data-leaving:animate-[pane-out_var(--duration-state)_var(--ease-out)_forwards]",
              )}
            >
              {pane.shown}
            </div>
          </aside>
        )}
        <Dialog.Root
          open={details !== null && modal}
          onOpenChange={(open, change) => {
            if (open) return;
            // Escape typed into the bot's browser page is the page's.
            if (change.reason === "escape-key" && change.event.defaultPrevented) {
              change.cancel();
              return;
            }
            onCloseDetails();
          }}
          onOpenChangeComplete={(open) => {
            if (!open) pane.gone();
          }}
        >
          <Dialog.Portal container={frame}>
            {/*
             * Beside the pane, the scrim closes it; a phone's details and its browser's live view
             * cover everything.
             */}
            <Dialog.Backdrop
              className={cn(
                "absolute inset-0 z-10 hidden bg-scrim transition-opacity duration-(--duration-slow) ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 @tablet:block",
                browser && "block",
              )}
            />
            <Dialog.Popup
              aria-labelledby={detailsHeadingId}
              aria-modal
              initialFocus={detailsHeadingRef}
              finalFocus={returnFocusRef}
              className={cn(
                "absolute inset-0 z-20 flex flex-col bg-background pr-[env(safe-area-inset-right)] outline-none transition-transform duration-(--duration-slide) ease-slide data-ending-style:duration-(--duration-state) data-ending-style:ease-out @max-tablet:pl-[env(safe-area-inset-left)] @tablet:start-auto @tablet:border-s @tablet:border-border @tablet:shadow-overlay @tablet:pt-(--inset-top) @tablet:data-ending-style:translate-x-full @tablet:data-starting-style:translate-x-full @tablet:rtl:data-ending-style:-translate-x-full @tablet:rtl:data-starting-style:-translate-x-full",
                browser
                  ? // The live view: the whole screen on a phone, rising from the bottom; over the conversation from the tablet up.
                    "@max-tablet:pt-(--inset-top) @max-tablet:data-ending-style:translate-y-full @max-tablet:data-starting-style:translate-y-full @tablet:w-[calc(100%_-_var(--layout-roster-width))]"
                  : "pt-(--inset-top) pb-[env(safe-area-inset-bottom)] data-ending-style:translate-x-full data-starting-style:translate-x-full rtl:data-ending-style:-translate-x-full rtl:data-starting-style:-translate-x-full @tablet:w-(--layout-details-width)",
              )}
            >
              {pane.shown}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </div>
  );
}
