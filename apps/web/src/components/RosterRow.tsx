// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { Avatar, BotId, RosterItem } from "@j3-bots/contracts";
import { needsOperator } from "@j3-bots/client-runtime";
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import { useI18n, usePresentation } from "../app/context";
import type { ComponentProps, Ref } from "react";
import { cn } from "../lib/cn";
import type { DataAttributes } from "../lib/dataAttributes";
import { activityTime, type LineTone, rosterLine } from "@j3-bots/client-runtime/wording";
import { type AvatarHandle, RoomAvatar } from "./avatar/BotAvatar";
import { LiveBotAvatar } from "./avatar/mood";
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
  const content = (
    <>
      <span className="[--avatar-cutout:var(--sidebar)] group-hover/row:[--avatar-cutout:var(--row-hover)] group-data-selected/row:[--avatar-cutout:var(--muted)]">
        {item._tag === "bot" ? (
          <LiveBotAvatar
            bot={item.bot}
            unread={item.unread}
            lastEntry={item.lastEntry}
            size={40}
            {...(avatarRef === undefined ? {} : { ref: avatarRef })}
          />
        ) : (
          <RoomAvatar members={memberAvatars} size={40} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className={cn("truncate text-sm", needs ? "font-semibold" : "font-medium")}>
            {name}
          </span>
          {item.lastActivityAt && (
            <span className="ms-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
              {activityTime(item.lastActivityAt, ctx)}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <SwapText text={line.text} className={cn("text-xs", toneClass[line.tone])} />
          {item.unread &&
            (unreadDot ? (
              <span className="ms-auto size-2 shrink-0 rounded-pill bg-accent">
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
    children: content,
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(own, props),
  });
}
