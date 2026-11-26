// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { Avatar, BotId, RosterItem } from "@j3-bots/contracts";
import { needsOperator } from "@j3-bots/client-runtime";
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import { useI18n, usePresentation } from "../app/context";
import { type BotColor, litter, resolveAvatar, stage } from "@j3-bots/design-tokens";
import type { ComponentProps, CSSProperties, Ref } from "react";
import { cn } from "../lib/cn";
import type { DataAttributes } from "../lib/dataAttributes";
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
   * The bot or room is new to the roster: it comes down into its row in a
   * light of its own color, and its words follow it in.
   */
  readonly entrance?: boolean;
}

/** The light a bot or a room comes down into, and how long it and the words after it take. */
const entranceStyle = (color: string): CSSProperties & Record<`--row-${string}`, string> => ({
  "--row-spot": color,
  "--row-light": `${stage.rowLight}ms`,
  "--row-words": `${stage.rowWords}ms`,
});

/** Where each of a 40 px avatar's dots stands: along its lower left edge, clear of the primary bot's star at the other corner. */
const DOT_PLACES = Array.from({ length: litter.most }, (_, i) => {
  const angle = ((118 + i * 21) * Math.PI) / 180;
  return { left: 15.5 + Math.cos(angle) * 22, top: 17.5 + Math.sin(angle) * 22 };
});

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
      {DOT_PLACES.map((place, i) => (
        <span key={place.top} aria-hidden data-on={i < count} style={place} />
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
  const content = (
    <>
      <span className="relative isolate [--avatar-cutout:var(--sidebar)] group-hover/row:[--avatar-cutout:var(--row-hover)] group-data-selected/row:[--avatar-cutout:var(--muted)]">
        {entrance && <span aria-hidden className="row-spot" />}
        {item._tag === "bot" ? (
          <PrimaryBadge primary={item.bot.primary} size={40}>
            <LiveBotAvatar
              bot={item.bot}
              unread={item.unread}
              lastEntry={item.lastEntry}
              size={40}
              entrance={entrance}
              {...(avatarRef === undefined ? {} : { ref: avatarRef })}
            />
          </PrimaryBadge>
        ) : (
          <RoomAvatar members={memberAvatars} size={40} entrance={entrance} />
        )}
        {item._tag === "bot" && (
          <LittleDots
            count={item.bot.state._tag === "working" ? item.bot.state.littleOnes : 0}
            color={resolveAvatar(item.bot.profile.avatar).color}
          />
        )}
      </span>
      <span className={cn("flex min-w-0 flex-1 flex-col", entrance && "row-words")}>
        <span className="flex items-baseline gap-2">
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
        <span className="flex items-center gap-2">
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
    ...(entrance ? { style: entranceStyle(spot) } : {}),
    children: content,
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(own, props),
  });
}
