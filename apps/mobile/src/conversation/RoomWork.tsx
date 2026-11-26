// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MEMBER_WORK_LINGER,
  memberWorkOf,
  roomMemberWork,
  shownPlan,
} from "@j3-bots/client-runtime/presentation";
import type { Bot, BotId, Room, TurnWork } from "@j3-bots/contracts";
import { resolveAvatar, springs } from "@j3-bots/design-tokens";
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
  const key = working.map((member) => member.botId).join("\n");
  // A member that just ran out of work to show stays until its last little one is home.
  const [kept, setKept] = useState(working);
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setKept([
      ...working,
      ...kept.filter((member) => !working.some((now) => now.botId === member.botId)),
    ]);
  }
  // Who had work to show as the room opened, and who has since been let go: anyone else's place
  // is new, so its little ones come out of it instead of being simply there.
  const [opened] = useState(() => working.map((member) => member.botId));
  const [gone, setGone] = useState<ReadonlyArray<BotId>>([]);
  // Who is listed starts the wait, and it lets go only if they are still the ones listed: the
  // room itself changes with every step.
  const letGo = useEffectEvent((listed: string) => {
    if (listed !== key) return;
    const left = kept.filter((member) => !working.some((now) => now.botId === member.botId));
    if (left.length === 0) return;
    setGone([...gone, ...left.map((member) => member.botId)]);
    setKept(working);
  });
  useEffect(() => {
    const timer = setTimeout(() => letGo(key), MEMBER_WORK_LINGER);
    return () => clearTimeout(timer);
  }, [key]);
  const shown = [
    ...working,
    ...kept.filter((member) => !working.some((now) => now.botId === member.botId)),
  ];
  return (
    <>
      {shown.map(({ botId }) => {
        const bot = bots.get(botId);
        if (bot === undefined) return null;
        return (
          <MemberWork
            key={botId}
            bot={bot}
            // What its turn is doing now, also once that is nothing to show: its last little one
            // then goes home as one that ended. Null once its turn for the room is over.
            work={memberWorkOf(room, botId)}
            born={!opened.includes(botId) || gone.includes(botId)}
          />
        );
      })}
    </>
  );
}

/**
 * One member's face and name, with its little ones and its plan under them;
 * `work` null once its turn for the room is over. `born` when its place is new
 * to the room as shown: its little ones come out of it.
 */
function MemberWork({
  bot,
  work,
  born,
}: {
  readonly bot: Bot;
  readonly work: TurnWork | null;
  readonly born: boolean;
}) {
  const face = useRef<AvatarHandle>(null);
  const plan = shownPlan(work);
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
        born={born}
      />
      {plan !== null && <PlanCard plan={plan} tint={resolveAvatar(bot.profile.avatar).color} />}
    </AnimatedView>
  );
}
