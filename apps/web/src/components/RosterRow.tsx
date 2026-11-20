// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { Avatar, RosterItem } from "@j3-bots/contracts";
import { useI18n, usePresentation } from "../app/context";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import type { DataAttributes } from "../lib/dataAttributes";
import { activityTime } from "../lib/time";
import { avatarAppearance } from "../presentation/avatar";
import { needsOperator, rosterLine, type LineTone } from "../presentation/roster";
import { BotAvatar, RoomAvatar } from "./BotAvatar";

export const toneClass: Record<LineTone, string> = {
  default: "text-muted-foreground",
  muted: "text-muted-foreground italic",
  waiting: "text-waiting",
  blocked: "text-blocked",
};

interface RosterRowProps extends useRender.ComponentProps<"button"> {
  readonly item: RosterItem;
  /** Avatars of the room's members, for a room row. */
  readonly memberAvatars?: ReadonlyArray<Avatar>;
  readonly selected: boolean;
}

/**
 * One bot or room in the roster: avatar, name, time, and one line of status.
 * Rows that need the operator carry their state in the line's words and color
 * and in the avatar's badge. Renders a button unless `render` gives a link.
 */
export function RosterRow({
  item,
  memberAvatars = [],
  selected,
  render,
  ...props
}: RosterRowProps) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const line = rosterLine(item, ctx);
  const needs = needsOperator(item);
  const name = item._tag === "bot" ? item.bot.profile.name : item.room.name;
  // A done bot's avatar already carries the unread badge; other rows mark it with a dot.
  const unreadDot =
    item.unread &&
    (item._tag === "room" || avatarAppearance(item.bot.state, item.unread).badge !== "unread");
  const content = (
    <>
      <span className="[--avatar-cutout:var(--sidebar)] group-hover/row:[--avatar-cutout:var(--muted)] group-data-selected/row:[--avatar-cutout:var(--muted)]">
        {item._tag === "bot" ? (
          <BotAvatar
            avatar={item.bot.profile.avatar}
            state={item.bot.state}
            unread={item.unread}
            size={36}
          />
        ) : (
          <RoomAvatar members={memberAvatars} size={36} />
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
          <span className={cn("truncate text-xs", toneClass[line.tone])}>{line.text}</span>
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
      "group/row flex h-(--layout-row-pointer) w-full items-center gap-3 rounded-md px-2 text-start outline-none transition-colors duration-(--duration-fast) hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent data-selected:bg-muted pointer-coarse:h-(--layout-row-touch)",
    type: render ? undefined : "button",
    "data-selected": selected ? "" : undefined,
    "aria-current": selected ? "page" : undefined,
    "data-roster-row": "",
    children: content,
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(own, props),
  });
}
