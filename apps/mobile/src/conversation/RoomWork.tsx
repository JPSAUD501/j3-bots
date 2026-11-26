// SPDX-License-Identifier: AGPL-3.0-or-later
import { roomMemberWork, shownPlan } from "@j3-bots/client-runtime/presentation";
import type { Bot, Room, TurnWork } from "@j3-bots/contracts";
import { litter, resolveAvatar, springs } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import type { AvatarHandle } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { settleIn } from "../motion.ts";
import { useBots } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { AnimatedView } from "./animated.ts";
import { LittleOnes } from "./LittleOnes.tsx";
import { PlanCard } from "./PlanCard.tsx";

/** How long a member's block stays once it has nothing left to show, in ms: its last little one is on its way home. */
const LINGER = (litter.failed + litter.failedDuck + 0.8) * 1000;

/**
 * At the end of a room, each member whose turn there has a plan or little
 * ones, as on the web: its face, its name, and under them what a conversation
 * shows under a turn's line. A room's turn shows them here only, never in the
 * member's own conversation. A member with neither is not listed: the line
 * that says who is answering covers it.
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
  // Who is listed starts the wait, and it lets go only if they are still the ones listed: the
  // room itself changes with every step.
  const letGo = useEffectEvent((listed: string) => {
    if (listed === key) setKept(roomMemberWork(room));
  });
  useEffect(() => {
    const timer = setTimeout(() => letGo(key), LINGER);
    return () => clearTimeout(timer);
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
  const plan = shownPlan(work?.plan ?? null);
  return (
    <AnimatedView entering={settleIn(springs.soft)} className="mt-2 px-4">
      {/* Drawn over its little ones, which come out from behind the bot's face. */}
      <View style={{ zIndex: 1 }} className="min-h-11 flex-row items-center gap-2.5">
        <LiveBotAvatar bot={bot} size={24} ref={face} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-xs font-medium text-foreground">
          {bot.profile.name}
        </Text>
      </View>
      <LittleOnes
        littleOnes={work?.littleOnes ?? null}
        live={work !== null}
        avatar={bot.profile.avatar}
        face={face}
      />
      {plan !== null && <PlanCard plan={plan} tint={resolveAvatar(bot.profile.avatar).color} />}
    </AnimatedView>
  );
}
