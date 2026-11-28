// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import { type Ref, type RefObject, useEffect, useImperativeHandle } from "react";
import { useI18n } from "../../app/context";
import type { DesktopBrowserBridge } from "../../live/desktop";
import type { BrowserViewerHandle } from "../BrowserViewer";
import { DesktopBrowser } from "./DesktopBrowser";
import { useBarPresence } from "./presence/bar";

/**
 * The desktop app's own browser beside the conversation: the tab `target`
 * names in front, or whichever was. Over the conversation, in a window too
 * narrow for both, it leads back to it.
 */
export function DesktopBrowserPanel({
  bridge,
  target,
  over,
  onClose,
  onSignIns,
  headingRef,
  headingId,
  held,
  ref,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly target: BrowserTabRef | "front";
  /** It lies over the conversation rather than beside it. */
  readonly over: boolean;
  readonly onClose: () => void;
  readonly onSignIns?: (() => void) | undefined;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly headingId: string;
  /** The panel is being resized: the page is shown as a still until it settles. */
  readonly held: boolean;
  readonly ref?: Ref<BrowserViewerHandle>;
}) {
  const { t } = useI18n();
  const presence = useBarPresence();
  useEffect(() => {
    // A tab named from the conversation comes in front beside it, wherever it was.
    if (target !== "front") bridge.command({ _tag: "show", tab: target, place: "panel" });
  }, [bridge, target]);
  // Nothing to hand back: what the person does on a tab here is theirs at once.
  useImperativeHandle(ref, () => ({ requestClose: (next) => (next ?? onClose)() }), [onClose]);
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <h2 ref={headingRef} id={headingId} tabIndex={-1} className="sr-only">
        {t("browser.open")}
      </h2>
      <DesktopBrowser
        bridge={bridge}
        place="panel"
        held={held}
        presence={presence}
        onClose={over ? undefined : onClose}
        onToConversation={over ? onClose : undefined}
        onSignIns={onSignIns}
      />
    </div>
  );
}
