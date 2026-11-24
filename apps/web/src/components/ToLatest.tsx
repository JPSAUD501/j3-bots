// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { CardPlace } from "@j3-bots/client-runtime/presentation";
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
 * Over the end of a conversation. While its bot waits on a card out of view,
 * "Waiting for you" with an arrow toward the card, which brings it into view.
 * Otherwise, scrolled up: "New messages" while others wrote some, else a
 * round button back to the newest entry once the operator is well away from
 * it. It pops in and out, and takes no focus while hidden.
 */
export function ToLatest({
  end,
  onPress,
  waiting,
}: {
  readonly end: ConversationEnd;
  readonly onPress: () => void;
  /** The card the bot waits on, where it is, and the way to it; null while it waits on nothing. */
  readonly waiting: { readonly place: CardPlace | null; readonly onPress: () => void } | null;
}) {
  const { t } = useI18n();
  const toCard = waiting !== null && (waiting.place === "above" || waiting.place === "below");
  const fresh = !toCard && end.unseen > 0;
  const shown = toCard || (!end.atEnd && (fresh || end.away));
  const worded = toCard || fresh;
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
          onClick={toCard ? waiting.onPress : onPress}
          aria-label={toCard ? t("timeline.toWaiting") : fresh ? undefined : t("timeline.toLatest")}
          className={cn(
            "pressable flex h-9 items-center justify-center gap-1.5 rounded-pill border border-border bg-surface text-sm font-medium shadow-overlay",
            toCard ? "text-waiting" : "text-foreground",
            shown && "pointer-events-auto",
            worded ? "ps-3.5 pe-3" : "pressable-round w-9",
          )}
        >
          {toCard && <span>{t("presence.waiting")}</span>}
          {fresh && <span>{t("timeline.newMessages")}</span>}
          {toCard && waiting.place === "above" ? (
            <ArrowUpIcon aria-hidden className="size-4" />
          ) : (
            <ArrowDownIcon aria-hidden className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}
