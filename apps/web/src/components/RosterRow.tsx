// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { Avatar, BotId, RosterItem } from "@j3-bots/contracts";
import { needsOperator } from "@j3-bots/client-runtime";
import {
  littleOneDots,
  MAX_SHOWN_LITTLE_ONES,
  rosterKeyOf,
  rosterKeyText,
} from "@j3-bots/client-runtime/presentation";
import { useI18n, usePresentation } from "../app/context";
import { type BotColor, littleDots, resolveAvatar, stage } from "@j3-bots/design-tokens";
import {
  type AnimationEvent,
  type ComponentProps,
  type CSSProperties,
  type Ref,
  useEffect,
  useState,
} from "react";
import { cn } from "../lib/cn";
import type { DataAttributes } from "../lib/dataAttributes";
import { reducedMotion } from "../lib/motion";
import { activityTime, type LineTone, rosterLine } from "@j3-bots/client-runtime/wording";
import { type AvatarHandle, RoomAvatar } from "./avatar/BotAvatar";
import { LiveBotAvatar } from "./avatar/mood";
import { PrimaryBadge } from "./avatar/PrimaryBadge";
import { SwapText } from "./SwapText";

export const toneClass: Record<LineTone, string> = {
  default: "text-muted-foreground",
  secondary: "text-muted-foreground",
  empty: "text-muted-foreground italic",
  waiting: "text-waiting",
  blocked: "text-blocked",
};

interface RosterRowProps extends useRender.ComponentProps<"button"> {
  readonly item: RosterItem;
  /** The room's members, for a room row. */
  readonly memberAvatars?: ReadonlyArray<{ readonly id: BotId; readonly avatar: Avatar }>;
  readonly selected: boolean;
  /** A bot row's avatar, to make it move: a row that rises makes its bot hop. */
  readonly avatarRef?: Ref<AvatarHandle>;
  /**
   * A menu button sits over the row's end (`RosterEntry`): while the row is
   * hovered or holds focus, the time and the unread dot make way for it.
   */
  readonly withMenu?: boolean;
  /**
   * The bot or room is new to the roster: it arrives in its row
   * (`useArrival`).
   */
  readonly entrance?: boolean;
}

/**
 * Where a row new to the roster is in its arrival: its light is on and its
 * bot on its way down (`lit`), its bot has landed (`landed`), or, under
 * reduced motion, it fades in (`calm`).
 */
type Arrival = "lit" | "landed" | "calm";

/** The light's own variables: the bot's color, and the arrival's times. */
const arrivalStyle = (color: string): CSSProperties & Record<`--row-${string}`, string> => ({
  "--row-spot": color,
  "--row-spot-in": `${stage.spotIn}ms`,
  "--row-hold": `${stage.rowHold}ms`,
  "--row-dim": `${stage.rowDim}ms`,
  "--row-gap": `${stage.focus.gap}ms`,
});

/**
 * A row's arrival, as one moment keyed to its bot's landing, as the first run
 * stages its cast (`stage`): the light comes up first, the bot sets off
 * `stage.spotLead` ms later and comes down into it, the row clipped to its
 * own height so it never crosses the row above; as it lands its words come
 * in and, a moment later, the light goes down. The landing is the avatar's
 * own, on the frame loop, so the light never goes down before the bot is
 * there however late its frames come; a bot no frame draws counts as landed
 * after `stage.rowLand`. The light and the words are the stylesheet's
 * (`.row-light` in `index.css`), so the arrival renders twice in all: as it
 * lands, and as it ends. Under reduced motion the row fades in.
 */
function useArrival(entrance: boolean) {
  const [arrival, setArrival] = useState<Arrival | null>(() =>
    entrance ? (reducedMotion() ? "calm" : "lit") : null,
  );
  const lit = arrival === "lit";
  useEffect(() => {
    if (!lit) return;
    const late = window.setTimeout(() => setArrival("landed"), stage.spotLead + stage.rowLand);
    return () => window.clearTimeout(late);
  }, [lit]);
  return {
    arrival,
    /** The bot's entrance, which sets off once the light is up and lands the row with it. */
    avatarEntrance: lit
      ? { delay: stage.spotLead, onLanded: () => setArrival("landed") }
      : (false as const),
    /** Ends the arrival once its last move has played: the light gone down, or the fade. */
    onAnimationEnd: (event: AnimationEvent) => {
      if (event.animationName === "row-light-out" || event.animationName === "row-calm") {
        setArrival(null);
      }
    },
  };
}

/** Where each of the row's avatar's dots stands: along its lower left edge, clear of the primary bot's star at the other corner. */
const DOTS = littleDots(40, MAX_SHOWN_LITTLE_ONES);

/**
 * While a bot is split, one tiny dot for each of its little ones at work,
 * by its avatar, four at most. Nothing more: what they do is in its
 * conversation. A dot pops in as one starts and away as one ends.
 */
function LittleDots({ count, color }: { readonly count: number; readonly color: BotColor }) {
  const { plural } = useI18n();
  return (
    <span
      className="little-dots"
      style={{ "--avatar-body": `var(--bot-little-${color})` } as CSSProperties}
    >
      {DOTS.places.map((place, i) => (
        <span
          key={place.y}
          aria-hidden
          data-on={i < littleOneDots(count).dots}
          style={{ left: place.x, top: place.y, width: DOTS.size, height: DOTS.size }}
        />
      ))}
      {count > 0 && <span className="sr-only">{plural("littleOnes.label", count)}</span>}
    </span>
  );
}

/**
 * One bot or room in the roster: avatar, name, time, and one line of status.
 * Rows that need the operator carry their state in the line's words and color
 * and in the avatar's light. Hover fills the row more lightly than the open
 * conversation's, so the two never read as one. Renders a button unless `render` gives a link.
 */
export function RosterRow({
  item,
  memberAvatars = [],
  selected,
  avatarRef,
  withMenu = false,
  entrance = false,
  render,
  ...props
}: RosterRowProps) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const line = rosterLine(item, ctx);
  const needs = needsOperator(item);
  const name = item._tag === "bot" ? item.bot.profile.name : item.room.name;
  // An idle bot's avatar already says it with its dark light; other rows mark it with a dot.
  const unreadDot = item.unread && (item._tag === "room" || item.bot.state._tag !== "idle");
  const makesWay = withMenu
    ? "transition-opacity duration-(--duration-fast) pointer-fine:group-hover/entry:opacity-0 pointer-fine:group-focus-within/entry:opacity-0 pointer-fine:group-has-data-popup-open/entry:opacity-0"
    : undefined;
  // A room's light is its first member's color.
  const face = item._tag === "bot" ? item.bot.profile.avatar : memberAvatars[0]?.avatar;
  const spot = face === undefined ? "var(--foreground)" : `var(--bot-${resolveAvatar(face).color})`;
  const { arrival, avatarEntrance, onAnimationEnd } = useArrival(entrance);
  const content = (
    <>
      <span className="row-stage relative isolate [--avatar-cutout:var(--sidebar)] group-hover/row:[--avatar-cutout:var(--row-hover)] group-data-selected/row:[--avatar-cutout:var(--muted)]">
        {(arrival === "lit" || arrival === "landed") && (
          <span aria-hidden className="row-light">
            <span className="row-beam" />
            <span className="row-pool" />
            <span className="row-shadow" />
          </span>
        )}
        <span className="row-body block">
          {item._tag === "bot" ? (
            <PrimaryBadge primary={item.bot.primary} size={40}>
              <LiveBotAvatar
                bot={item.bot}
                unread={item.unread}
                lastEntry={item.lastEntry}
                size={40}
                entrance={avatarEntrance}
                {...(avatarRef === undefined ? {} : { ref: avatarRef })}
              />
            </PrimaryBadge>
          ) : (
            <RoomAvatar members={memberAvatars} size={40} entrance={avatarEntrance} />
          )}
        </span>
        {item._tag === "bot" && (
          <LittleDots
            count={item.bot.state._tag === "working" ? item.bot.state.littleOnes : 0}
            color={resolveAvatar(item.bot.profile.avatar).color}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="row-name flex items-baseline gap-2">
          <span className={cn("truncate text-sm", needs ? "font-semibold" : "font-medium")}>
            {name}
          </span>
          {item.lastActivityAt && (
            <span
              className={cn(
                "ms-auto shrink-0 text-2xs text-muted-foreground tabular-nums",
                makesWay,
              )}
            >
              {activityTime(item.lastActivityAt, ctx)}
            </span>
          )}
        </span>
        <span className="row-line flex items-center gap-2">
          <SwapText text={line.text} className={cn("text-xs", toneClass[line.tone])} />
          {item.unread &&
            (unreadDot ? (
              <span className={cn("ms-auto size-2 shrink-0 rounded-pill bg-accent", makesWay)}>
                <span className="sr-only">{t("roster.unread")}</span>
              </span>
            ) : (
              <span className="sr-only">{t("roster.unread")}</span>
            ))}
        </span>
      </span>
    </>
  );
  const own: ComponentProps<"button"> & DataAttributes = {
    className:
      "group/row pressable pressable-row flex h-(--layout-row-pointer) w-full items-center gap-3 rounded-lg px-2.5 text-start hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent data-selected:bg-muted pointer-coarse:h-(--layout-row-touch)",
    type: render ? undefined : "button",
    "data-selected": selected ? "" : undefined,
    "aria-current": selected ? "page" : undefined,
    // Which bot or room the row is, so focus can come back to it.
    "data-roster-row": rosterKeyText(rosterKeyOf(item)),
    ...(arrival === null
      ? {}
      : { "data-arrival": arrival, style: arrivalStyle(spot), onAnimationEnd }),
    children: content,
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(own, props),
  });
}
