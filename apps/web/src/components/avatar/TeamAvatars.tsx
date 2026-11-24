// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, PairBotIds } from "@j3-bots/contracts";
import { memberStack } from "@j3-bots/client-runtime/presentation";
import { pairOrder } from "@j3-bots/client-runtime/wording";
import { roomAvatarShare } from "@j3-bots/design-tokens";
import { use } from "react";
import { useBots, usePresentation } from "../../app/context";
import { cn } from "../../lib/cn";
import { AvatarsAsleep, BotAvatar } from "./BotAvatar";

/**
 * One bot's face, still, by id: a bot deleted since is a plain disc, as its
 * name is "A deleted bot". The words beside it name the bot.
 */
export function FaceOf({
  botId,
  size,
  cutout = false,
}: {
  botId: BotId;
  size: number;
  cutout?: boolean;
}) {
  const bot = useBots().get(botId);
  const asleep = use(AvatarsAsleep);
  if (bot === undefined) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-block shrink-0 rounded-pill bg-muted-strong",
          cutout && "ring-2 ring-[var(--avatar-cutout,var(--background))]",
        )}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <BotAvatar
      avatar={bot.profile.avatar}
      seed={bot.id}
      state={asleep ? "offline" : "idle"}
      size={size}
      still
      cutout={cutout}
    />
  );
}

/**
 * A teammate conversation's picture: its two bots overlapping, as a room's is
 * drawn, in the order its title names them.
 */
export function PairAvatar({ botIds, size }: { botIds: PairBotIds; size: number }) {
  const [back, front] = pairOrder(botIds, usePresentation());
  const part = Math.round(size * roomAvatarShare);
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <span className="absolute top-0 left-0 flex">
        <FaceOf botId={back} size={part} />
      </span>
      <span className="absolute right-0 bottom-0 flex">
        <FaceOf botId={front} size={part} cutout />
      </span>
    </span>
  );
}

/**
 * A room's members in its header: the first three overlapping in a row, then
 * how many more there are ("+2"). The header's name and line say who they are.
 */
export function MemberStack({ members, size }: { members: ReadonlyArray<BotId>; size: number }) {
  const { shown, more } = memberStack(members);
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {shown.map((botId, index) => (
        <span key={botId} className={cn("flex", index > 0 && "-ms-2.5")}>
          <FaceOf botId={botId} size={size} cutout={index > 0} />
        </span>
      ))}
      {more > 0 && (
        <span
          className="-ms-1.5 flex items-center justify-center rounded-pill bg-muted-strong px-1.5 text-2xs font-medium text-muted-foreground tabular-nums ring-2 ring-[var(--avatar-cutout,var(--background))]"
          style={{ height: size, minWidth: size }}
        >
          +{more}
        </span>
      )}
    </span>
  );
}
