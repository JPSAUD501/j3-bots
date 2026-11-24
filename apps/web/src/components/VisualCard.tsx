// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { type Visual, VISUAL_FRAME_PATH } from "@j3-bots/contracts";
import {
  readVisualHeight,
  type VisualAppearance,
  VISUAL_FRAME_SANDBOX,
  visualDocument,
} from "@j3-bots/client-runtime/presentation";
import { Maximize2Icon, XIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { usePreferences } from "../preferences/preferences";
import { Button } from "./ui/button";
import { dialogBackdrop, screenDialog } from "./ui/dialog";

// A bot's visual: a page it built, drawn in a frame that shares nothing with
// the client. docs/architecture/security.md, "Visuals", says how the frame is
// shut and why; docs/design/design-language.md says how it sits in a
// conversation.

/**
 * The theme visuals below are drawn in, where it is not the app's: a panel
 * that shows one theme beside the other, as the gallery does. Null follows
 * the app's.
 */
export const VisualTheme = createContext<VisualAppearance | null>(null);

/** The height a frame starts at when the bot measured none. */
const DEFAULT_HEIGHT = 240;

/**
 * How long a frame has to show its page, from when it is drawn. One that has
 * not reported its height by then never loaded, or is stuck in a script that
 * never ends, and is shown as failed.
 */
const REPORT_TIMEOUT = 10_000;

type FrameState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "shown"; readonly height: number }
  | { readonly _tag: "failed" };

/**
 * The height a message from a page reports, when it came from `frame`, the
 * window of that page's own frame; null for any other sender, a visual in
 * another frame included, and for anything but a height.
 */
export const ownFrameHeight = (
  event: { readonly source: unknown; readonly data: unknown },
  frame: object | null | undefined,
): number | null =>
  frame !== null && frame !== undefined && event.source === frame
    ? readVisualHeight(event.data)
    : null;

interface VisualFrameProps {
  readonly visual: Visual;
  readonly appearance: VisualAppearance;
  /** Fills the space it is given, as full screen does, rather than taking the page's height. */
  readonly fill: boolean;
}

/**
 * The frame, with its placeholder while the page loads and the line that
 * says when it could not be shown: at once for a page that embeds another
 * document, which a visual may not hold.
 */
function VisualFrame({ visual, appearance, fill }: VisualFrameProps) {
  const html = visualDocument(visual.html, appearance);
  return html === null ? (
    <VisualFailed fill={fill} />
  ) : (
    <LoadingFrame html={html} title={visual.title} height={visual.height} fill={fill} />
  );
}

function VisualFailed({ fill }: { readonly fill: boolean }) {
  const { t } = useI18n();
  return (
    <p
      role="status"
      className={cn(
        "flex items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground",
        fill && "flex-1",
      )}
    >
      {t("visual.failed")}
    </p>
  );
}

interface LoadingFrameProps {
  /** The visual's document, as `visualDocument` builds it. */
  readonly html: string;
  readonly title: string;
  /** The height the bot measured, which the frame starts at. */
  readonly height: number | null;
  readonly fill: boolean;
}

/**
 * Loads the client's visual page, in a sandbox with scripts only, and posts
 * it the visual's document; it takes nothing back but the page's height.
 */
function LoadingFrame({ html, title, height: measured, fill }: LoadingFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<FrameState>({ _tag: "loading" });
  // Writing the document loads the frame again, which is not another start.
  const posted = useRef(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const height = ownFrameHeight(event, frame.current?.contentWindow);
      if (height !== null) setState({ _tag: "shown", height });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (state._tag !== "loading") return;
    const timer = window.setTimeout(() => setState({ _tag: "failed" }), REPORT_TIMEOUT);
    return () => window.clearTimeout(timer);
  }, [state._tag]);

  if (state._tag === "failed") return <VisualFailed fill={fill} />;
  const height = state._tag === "shown" ? state.height : (measured ?? DEFAULT_HEIGHT);
  return (
    <div className={cn("relative", fill && "min-h-0 flex-1")} style={fill ? undefined : { height }}>
      <iframe
        ref={frame}
        src={VISUAL_FRAME_PATH}
        sandbox={VISUAL_FRAME_SANDBOX}
        title={title}
        referrerPolicy="no-referrer"
        className={cn("block size-full border-0", state._tag === "loading" && "invisible")}
        onLoad={(event) => {
          // The first load is the empty visual page, ready for its document.
          if (posted.current) return;
          posted.current = true;
          event.currentTarget.contentWindow?.postMessage(html, "*");
        }}
      />
      {state._tag === "loading" && <span aria-hidden className="skeleton absolute inset-3" />}
    </div>
  );
}

/**
 * A visual a bot showed above its message: the page, its title, and a way to
 * open it full screen. It follows the app's theme: a change draws the page
 * again in the new one.
 */
export function VisualCard({ visual }: { readonly visual: Visual }) {
  const { t } = useI18n();
  const { theme: appTheme } = usePreferences();
  const theme = useContext(VisualTheme) ?? appTheme;
  return (
    <figure className="flex w-(--layout-card-width) flex-col overflow-hidden rounded-bubble border border-border bg-surface">
      <VisualFrame key={theme} visual={visual} appearance={theme} fill={false} />
      <figcaption className="flex min-h-10 items-center gap-2 border-t border-border ps-3 pe-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{visual.title}</span>
        <Dialog.Root>
          <Dialog.Trigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={t("visual.expand", { title: visual.title })}
              />
            }
          >
            <Maximize2Icon aria-hidden />
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop className={dialogBackdrop} />
            <Dialog.Popup
              className={`${screenDialog} tablet:top-8 tablet:bottom-8 tablet:max-w-5xl tablet:overflow-hidden`}
            >
              <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border ps-4 pe-2">
                <Dialog.Title className="display-type min-w-0 flex-1 truncate text-lg">
                  {visual.title}
                </Dialog.Title>
                <Dialog.Close
                  render={
                    <Button variant="ghost-muted" size="icon" aria-label={t("visual.close")} />
                  }
                >
                  <XIcon aria-hidden />
                </Dialog.Close>
              </header>
              <VisualFrame key={theme} visual={visual} appearance={theme} fill />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </figcaption>
    </figure>
  );
}
