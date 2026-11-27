// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot } from "@j3-bots/contracts";
import { resolveAvatar } from "@j3-bots/design-tokens";
import { BotAvatar } from "../components/avatar/BotAvatar";
import { cn } from "../lib/cn";

/**
 * A bot's own pointer over the page, in its color, with a small label of its
 * face and name, as editors written by many hands show who is where. The
 * name folds to the face once the pointer has been still a while (`named`
 * false). A click rings where it landed; `clicked` is the click's sequence,
 * so each ring is its own. It fades while the person holds the tab. `at` is
 * where it points, as fractions of the page's width and height.
 */
export function BotCursor({
  bot,
  at,
  clicked,
  named,
  faded = false,
}: {
  readonly bot: Bot;
  readonly at: { readonly x: number; readonly y: number };
  readonly clicked: number | null;
  readonly named: boolean;
  readonly faded?: boolean;
}) {
  const ink = `var(--bot-${resolveAvatar(bot.profile.avatar).color})`;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute transition-[left,top,opacity] duration-(--duration-state) ease-out",
        faded && "opacity-35",
      )}
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
    >
      {clicked !== null && (
        <span
          key={clicked}
          className="pop-in absolute -start-3 -top-3 size-6 rounded-pill border-2"
          style={{ borderColor: ink }}
        />
      )}
      <svg width="18" height="20" viewBox="0 0 18 20" className="block">
        <path
          d="M1 1 L1 16 L5.5 12 L8.5 19 L11 18 L8 11 L14 11 Z"
          fill={ink}
          stroke="var(--background)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="absolute start-3 top-3.5 flex items-center gap-1 rounded-pill border bg-surface py-0.5 ps-0.5 text-2xs font-medium whitespace-nowrap text-foreground shadow-raised"
        style={{ borderColor: ink, paddingInlineEnd: named ? 8 : 2 }}
      >
        <BotAvatar avatar={bot.profile.avatar} seed={bot.id} state="working" size={16} still />
        {named && bot.profile.name}
      </span>
    </span>
  );
}
