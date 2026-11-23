// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AvatarChoice } from "@j3-bots/contracts";
import { avatarCast } from "@j3-bots/design-tokens";
import { BotAvatar } from "../components/avatar/BotAvatar";
import { cn } from "../lib/cn";
import { springAnimation } from "./motion";

interface Member {
  readonly look: AvatarChoice;
  /** In px. */
  readonly size: number;
  /** Where its centre sits, in % of the cast's box. */
  readonly x: number;
  readonly y: number;
  /** How long one float takes, in ms: each its own, so no two move together. */
  readonly float: number;
}

/** The cast's look at `index`: the first is the one the first bot starts with. */
const at = (index: number): AvatarChoice => avatarCast[index % avatarCast.length] ?? avatarCast[0];

/** A small crowd of bots, the largest in the middle, the rest around and in front of it. */
const members: ReadonlyArray<Member> = [
  { look: at(0), size: 96, x: 50, y: 40, float: 3400 },
  { look: at(3), size: 64, x: 17, y: 52, float: 2900 },
  { look: at(1), size: 68, x: 83, y: 50, float: 3700 },
  { look: at(2), size: 60, x: 33, y: 76, float: 3100 },
  { look: at(5), size: 52, x: 69, y: 80, float: 2700 },
];

/**
 * The team still to come, for the screens before the first bot: each bot pops
 * in after the one before it, then floats on its own clock. `compact` is for
 * screens with a form under it.
 */
export function Cast({ compact = false }: { readonly compact?: boolean }) {
  const scale = compact ? 0.72 : 1;
  return (
    <span
      aria-hidden
      className={cn(
        "relative block w-72 shrink-0 [--avatar-cutout:var(--background)]",
        compact ? "h-32" : "h-48",
      )}
    >
      {members.map((member, index) => (
        <span
          key={`${member.look.shape}/${member.look.color}`}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${member.x}%`, top: `${member.y}%`, zIndex: index === 0 ? 0 : index }}
        >
          <span
            className="block"
            style={{ animation: springAnimation("pop-in", "pop", 90 * index) }}
          >
            <span
              className="block"
              style={{
                animation: `onboarding-float ${member.float}ms ease-in-out calc(var(--duration-pop) + ${90 * index}ms) infinite`,
              }}
            >
              <BotAvatar
                avatar={member.look}
                seed={`cast-${member.look.shape}`}
                state="idle"
                size={Math.round(member.size * scale)}
              />
            </span>
          </span>
        </span>
      ))}
    </span>
  );
}
