// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import type { Reaction, ReactionEmoji, Reactor } from "@j3-bots/contracts";
import {
  QUICK_REACTIONS,
  REACTION_GROUPS,
  type ReactionGroupId,
  type ReactionPill,
  ownReaction,
  reactionAfterPick,
  reactionPills,
} from "@j3-bots/client-runtime/presentation";
import { springs } from "@j3-bots/design-tokens";
import { PlusIcon, SmilePlusIcon } from "lucide-react";
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useBots, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { play } from "../lib/motion";
import { touchTarget } from "../lib/touchTarget";

/** Sets the operator's reaction on the message, or takes it off with `null`. */
export type OnReact = (emoji: ReactionEmoji | null) => void;

/** What the reaction bar shows open: its quick reactions, or the picker of all of them. */
export type ReactionView = "quick" | "picker";

const popup =
  "origin-(--transform-origin) rounded-lg border border-border bg-surface text-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out";

const emojiButton = cn(
  "pressable pressable-round inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-xl leading-none outline-none hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-accent/15",
  touchTarget,
);

/**
 * The reactions on a message, one pill for each emoji: who reacted shows on
 * hover or focus. A pill holding the operator's reaction is marked, and takes
 * it off; another sets that emoji as theirs. A pill that arrives while the
 * message is on screen pops in.
 */
export function ReactionPills({
  reactions,
  onReact,
  fromOperator,
}: {
  readonly reactions: ReadonlyArray<Reaction>;
  readonly onReact: OnReact;
  /** On the operator's side the pills line up at the end, under their bubble. */
  readonly fromOperator: boolean;
}) {
  // The pills there when the message first showed appear in place; only later ones pop in.
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
  }, []);
  return (
    // With no reactions it takes no room, and stays mounted, so the first one to arrive pops in.
    <div
      className={cn(
        "flex max-w-(--layout-bubble-width) flex-wrap gap-1 empty:hidden",
        fromOperator && "justify-end",
      )}
    >
      {reactionPills(reactions).map((pill) => (
        <Pill
          key={pill.emoji}
          pill={pill}
          arrives={shown}
          onClick={() => onReact(reactionAfterPick(reactions, pill.emoji))}
        />
      ))}
    </div>
  );
}

function Pill({
  pill,
  arrives,
  onClick,
}: {
  readonly pill: ReactionPill;
  /** True once the message has shown: a pill mounting after that is one that just arrived. */
  readonly arrives: RefObject<boolean>;
  readonly onClick: () => void;
}) {
  const { t, plural, locale } = useI18n();
  const bots = useBots();
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!arrives.current || element === null) return;
    play(
      element,
      [
        { opacity: 0, transform: "scale(0.6)" },
        { opacity: 1, transform: "none" },
      ],
      springs.pop,
    );
  }, [arrives]);
  const nameOf = (by: Reactor) =>
    by._tag === "operator"
      ? t("reaction.you")
      : (bots.get(by.botId)?.profile.name ?? t("bot.unknown"));
  const names = new Intl.ListFormat(locale, { type: "conjunction" }).format(pill.by.map(nameOf));
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        ref={ref}
        type="button"
        delay={300}
        aria-label={
          pill.mine
            ? t("reaction.pill.mine", { emoji: pill.emoji })
            : plural("reaction.pill", pill.count, { emoji: pill.emoji })
        }
        aria-description={names}
        onClick={onClick}
        className={cn(
          "pressable inline-flex h-6 cursor-pointer items-center gap-1 rounded-pill border px-2 text-xs font-medium tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-8 pointer-coarse:px-2.5",
          pill.mine
            ? "border-accent/60 bg-accent/12 text-foreground hover:bg-accent/20"
            : "border-transparent bg-muted text-muted-foreground hover:bg-muted-strong hover:text-foreground",
        )}
      >
        <span aria-hidden className="text-sm leading-none">
          {pill.emoji}
        </span>
        {pill.count > 1 && <span aria-hidden>{pill.count}</span>}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6} className="z-50">
          <Tooltip.Popup
            className={cn(
              popup,
              "max-w-[min(18rem,calc(100vw-2rem))] px-2.5 py-1.5 text-xs leading-snug",
            )}
          >
            {names}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const groupNames = {
  smileys: "reaction.group.smileys",
  gestures: "reaction.group.gestures",
  hearts: "reaction.group.hearts",
  nature: "reaction.group.nature",
  food: "reaction.group.food",
  activities: "reaction.group.activities",
  objects: "reaction.group.objects",
} as const satisfies Record<ReactionGroupId, `reaction.group.${ReactionGroupId}`>;

/**
 * The button that opens the reaction bar beside a message (`MessageBubble`
 * places it): it shows while the pointer is over the message, while it has
 * focus, and while the bar is open.
 * The bar holds the quick reactions and More, which opens the picker in its
 * place. Picking sets the operator's reaction, or takes it off when it was
 * theirs already, and closes the bar.
 */
export function ReactButton({
  reactions,
  onReact,
  fromOperator,
  defaultView,
}: {
  readonly reactions: ReadonlyArray<Reaction>;
  readonly onReact: OnReact;
  /** On the operator's side the bar opens toward their bubble's end; on a bot's, its start. */
  readonly fromOperator: boolean;
  /** Shows the bar open from the start, as the gallery does. */
  readonly defaultView?: ReactionView;
}) {
  const { t } = useI18n();
  const headings = useId();
  const [view, setView] = useState<ReactionView>(defaultView ?? "quick");
  const picker = useRef<HTMLDivElement>(null);
  // A bar shown open from the start leaves focus where it is: only one the operator opens takes it.
  const openedByHand = useRef(defaultView === undefined);
  const own = ownReaction(reactions);
  const pick = (emoji: ReactionEmoji) => onReact(reactionAfterPick(reactions, emoji));
  const choice = (emoji: ReactionEmoji) => (
    <Popover.Close
      key={emoji}
      aria-pressed={own === emoji}
      onClick={() => pick(emoji)}
      className={emojiButton}
    >
      {emoji}
    </Popover.Close>
  );
  return (
    <Popover.Root
      defaultOpen={defaultView !== undefined}
      onOpenChange={() => {
        openedByHand.current = true;
      }}
      onOpenChangeComplete={(open) => {
        if (!open) setView("quick");
      }}
    >
      <Popover.Trigger
        aria-label={t("reaction.add")}
        className={cn(
          "pressable pressable-round inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground opacity-0 transition-[opacity,color,background-color] duration-(--duration-fast) ease-out group-hover/message:opacity-100 group-focus-within/message:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent data-popup-open:bg-muted data-popup-open:text-foreground data-popup-open:opacity-100",
          touchTarget,
        )}
      >
        <SmilePlusIcon aria-hidden className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align={fromOperator ? "end" : "start"}
          sideOffset={6}
          className="z-50"
        >
          <Popover.Popup
            aria-label={t("reaction.add")}
            initialFocus={() => openedByHand.current}
            className={popup}
          >
            {view === "quick" ? (
              <div className="flex items-center gap-0.5 p-1">
                {QUICK_REACTIONS.map(choice)}
                <button
                  type="button"
                  aria-label={t("reaction.more")}
                  onClick={() => {
                    // The picker takes the bar's place, and focus goes on to its first emoji.
                    flushSync(() => setView("picker"));
                    picker.current?.querySelector("button")?.focus();
                  }}
                  className={cn(emojiButton, "text-muted-foreground hover:text-foreground")}
                >
                  <PlusIcon aria-hidden className="size-4" />
                </button>
              </div>
            ) : (
              <div className="flex max-h-[min(22rem,var(--available-height))] w-[min(20.5rem,calc(100vw-2rem))] flex-col">
                <Popover.Title className="px-3 pt-2.5 pb-1 text-sm font-medium">
                  {t("reaction.picker")}
                </Popover.Title>
                <div ref={picker} className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
                  {REACTION_GROUPS.map((group) => (
                    <section key={group.id} aria-labelledby={`${headings}-${group.id}`}>
                      <h3
                        id={`${headings}-${group.id}`}
                        className="px-1.5 pt-2 pb-1 text-2xs font-medium text-muted-foreground"
                      >
                        {t(groupNames[group.id])}
                      </h3>
                      <div className="grid grid-cols-8 pointer-coarse:grid-cols-7">
                        {group.emoji.map(choice)}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
