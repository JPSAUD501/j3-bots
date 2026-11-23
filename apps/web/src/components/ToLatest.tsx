// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownIcon } from "lucide-react";
import type { ConversationEnd } from "@j3-bots/client-runtime/react";
import { useEffect } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { reducedMotion } from "../lib/motion";

/**
 * Feeds `follow` from `element`'s scroll, an element laid out newest first
 * (`flex-col-reverse`, whose end is a scroll of 0).
 */
export function useScrollFollow(
  element: HTMLElement | null,
  follow: ConversationEnd["follow"],
): void {
  useEffect(() => {
    if (element === null) return;
    const onScroll = () => follow(Math.abs(element.scrollTop), element.clientHeight);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [element, follow]);
}

/** Back to `element`'s end, the newest entry: at once under reduced motion. */
export const scrollToEnd = (element: HTMLElement | null) => {
  element?.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
};

/**
 * Over the end of a conversation scrolled up: "New messages" while others
 * wrote some, else a round button back to the newest entry once the operator
 * is well away from it. It pops in and out, and takes no focus while hidden.
 */
export function ToLatest({
  end,
  onPress,
}: {
  readonly end: ConversationEnd;
  readonly onPress: () => void;
}) {
  const { t } = useI18n();
  const fresh = end.unseen > 0;
  const shown = !end.atEnd && (fresh || end.away);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
      <div
        data-shown={shown}
        className="scale-50 opacity-0 transition-[scale,opacity] duration-(--duration-pop) ease-pop data-[shown=true]:scale-100 data-[shown=true]:opacity-100"
      >
        <button
          type="button"
          inert={!shown}
          aria-hidden={!shown}
          onClick={onPress}
          aria-label={fresh ? undefined : t("timeline.toLatest")}
          className={cn(
            "pressable flex h-9 items-center justify-center gap-1.5 rounded-pill border border-border bg-surface text-sm font-medium text-foreground shadow-overlay",
            shown && "pointer-events-auto",
            fresh ? "ps-3.5 pe-3" : "pressable-round w-9",
          )}
        >
          {fresh && <span>{t("timeline.newMessages")}</span>}
          <ArrowDownIcon aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
