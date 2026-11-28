// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AvatarState, FaceLight } from "@j3-bots/client-runtime/presentation";
import type { BotId } from "@j3-bots/contracts";
import { useBots } from "../app/context";
import { BotAvatar } from "../components/avatar/BotAvatar";
import { cn } from "../lib/cn";

/** How many faces show before they stop overlapping into one more. */
const SHOWN = 3;

const stateOf = {
  acting: "working",
  waiting: "waiting",
  still: "idle",
} as const satisfies Record<FaceLight, AvatarState>;

/**
 * The faces of the bots on a tab, overlapping, the most recent in front: the
 * antenna's light is on for the one acting, amber for one that waits for the
 * person. A tab with no bot shows nothing. Words beside them say who they
 * are, so the faces are hidden from assistive technology. `faces` is what
 * `tabFaces` gives.
 */
export function Faces({
  faces,
  size = 20,
  className,
}: {
  readonly faces: ReadonlyArray<{ readonly botId: BotId; readonly light: FaceLight }>;
  readonly size?: number;
  readonly className?: string;
}) {
  const bots = useBots();
  const shown = faces.flatMap((face) => {
    const bot = bots.get(face.botId);
    return bot === undefined ? [] : [{ bot, light: face.light }];
  });
  if (shown.length === 0) return null;
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center", className)}>
      {shown
        .slice(0, SHOWN)
        .reverse()
        .map(({ bot, light }, index) => (
          <BotAvatar
            key={bot.id}
            avatar={bot.profile.avatar}
            seed={bot.id}
            state={stateOf[light]}
            size={size}
            still
            cutout
            className={index === 0 ? "" : "-ms-1.5"}
          />
        ))}
    </span>
  );
}
