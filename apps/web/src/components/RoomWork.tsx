// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, Room, TurnWork } from "@j3-bots/contracts";
import { roomMemberWork, shownPlan } from "@j3-bots/client-runtime/presentation";
import { litter, resolveAvatar } from "@j3-bots/design-tokens";
import { useEffect, useRef, useState } from "react";
import { useBots } from "../app/context";
import type { AvatarHandle } from "./avatar/BotAvatar";
import { LiveBotAvatar } from "./avatar/mood";
import { LittleOnes } from "./LittleOnes";
import { PlanCard } from "./PlanCard";

/** How long a member's block stays once it has nothing left to show, in ms: its last little one is on its way home. */
const LINGER = (litter.failed + litter.failedDuck + 0.8) * 1000;

/**
 * At the end of a room, each member whose turn there has a plan or little
 * ones: its face, its name, and under them what a conversation shows under a
 * turn's line. A room's turn shows them here only, never in the member's own
 * conversation. A member with neither is not listed: the line that says who
 * is answering covers it.
 */
export function RoomWork({ room }: { readonly room: Room }) {
  const bots = useBots();
  const working = roomMemberWork(room);
  // A member that just ran out of work to show stays until its last little one is home.
  const [kept, setKept] = useState(working);
  const key = working.map((member) => member.botId).join("\n");
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setKept([
      ...working,
      ...kept.filter((member) => !working.some((now) => now.botId === member.botId)),
    ]);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => setKept(roomMemberWork(room)), LINGER);
    return () => window.clearTimeout(timer);
    // Only who is listed starts the wait: the room itself changes with every step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const shown = [
    ...working,
    ...kept.filter((member) => !working.some((now) => now.botId === member.botId)),
  ];
  return (
    <>
      {shown.map((member) => {
        const bot = bots.get(member.botId);
        if (bot === undefined) return null;
        const live = working.some((now) => now.botId === member.botId);
        return <MemberWork key={member.botId} bot={bot} work={live ? member.work : null} />;
      })}
    </>
  );
}

/** One member's face and name, with its little ones and its plan under them; `work` null once it has none left. */
function MemberWork({ bot, work }: { readonly bot: Bot; readonly work: TurnWork | null }) {
  const face = useRef<AvatarHandle>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const plan = shownPlan(work?.plan ?? null);
  return (
    <div className="arrive mt-3 max-w-(--layout-card-width) origin-bottom-left">
      <div className="flex min-h-8 items-center gap-2.5 text-xs">
        <span ref={anchor} className="relative z-2 flex shrink-0">
          <LiveBotAvatar bot={bot} size={24} ref={face} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{bot.profile.name}</span>
      </div>
      <LittleOnes
        littleOnes={work?.littleOnes ?? null}
        live={work !== null}
        avatar={bot.profile.avatar}
        face={face}
        anchor={anchor}
      />
      {plan !== null && <PlanCard plan={plan} tint={resolveAvatar(bot.profile.avatar).color} />}
    </div>
  );
}
