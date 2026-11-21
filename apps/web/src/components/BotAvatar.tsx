// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, BotState } from "@j3-bots/contracts";
import {
  avatarShapes,
  botPalette,
  type AvatarShapeName,
  type BotColor,
} from "@j3-bots/design-tokens";
import type { CSSProperties } from "react";
import {
  avatarAppearance,
  type AvatarBadge,
  type AvatarMark,
} from "@j3-bots/client-runtime/presentation";
import { useChanges } from "../lib/useChanges";

const isShape = (token: string): token is AvatarShapeName => Object.hasOwn(avatarShapes, token);
const isColor = (token: string): token is BotColor => Object.hasOwn(botPalette, token);

/** An avatar's tokens as this client draws them; unknown tokens fall back instead of failing. */
function resolve(avatar: Avatar) {
  return {
    shape: avatarShapes[isShape(avatar.shape) ? avatar.shape : "circle"],
    color: isColor(avatar.color) ? avatar.color : "gray",
  };
}

const colorStyle = (color: BotColor): CSSProperties => ({ color: `var(--bot-${color})` });

interface BotAvatarProps {
  readonly avatar: Avatar;
  readonly state: BotState;
  /** Whether the bot said something the operator has not read; an idle bot then shows as done. */
  readonly unread?: boolean;
  /** In px. 24 in lists, 36 in the roster, 96 on a profile. */
  readonly size: number;
  /** Draws the state without motion: for notifications, and to preview reduced motion. */
  readonly still?: boolean;
  /** The bot's name and state for assistive technology; omit when text next to it says the same. */
  readonly label?: string;
}

/**
 * A bot's face: its shape filled with its color, one mark inside that changes
 * with the state, and a corner badge when the state concerns the operator.
 * When the mark changes, the new one comes in and the shape nudges once; an
 * avatar that mounts already in a state shows it without either.
 */
export function BotAvatar({
  avatar,
  state,
  unread = false,
  size,
  still = false,
  label,
}: BotAvatarProps) {
  const { shape, color } = resolve(avatar);
  const look = avatarAppearance(state, unread);
  // Keys on the count of changes restart the one-time animations on each change.
  const changes = useChanges(look.mark);
  const changed = changes > 0;
  // Small avatars draw a larger mark so it stays legible.
  const markScale = size <= 28 ? 1.3 : 1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="avatar shrink-0 overflow-visible"
      style={colorStyle(color)}
      data-still={still ? "" : undefined}
      data-motion={look.motion}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <g key={changes} className={changed ? "avatar-nudge" : undefined}>
        <path d={shape.path} fill="currentColor" />
      </g>
      <g transform={`translate(${shape.mark.x} ${shape.mark.y}) scale(${markScale})`}>
        <g key={changes} className={changed ? "avatar-mark-in" : undefined}>
          <Mark mark={look.mark} />
        </g>
      </g>
      {look.badge && <Badge badge={look.badge} small={size <= 28} />}
    </svg>
  );
}

const INK = "var(--avatar-ink)";
const STROKE = 7;
const R = 12;

/** A point on the mark's circle; 0° is the top, angles grow clockwise. */
const at = (degrees: number) => {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return `${(R * Math.cos(rad)).toFixed(2)} ${(R * Math.sin(rad)).toFixed(2)}`;
};

function Mark({ mark }: { mark: AvatarMark }) {
  const stroke = {
    fill: "none",
    stroke: INK,
    strokeWidth: STROKE,
    strokeLinecap: "round",
  } as const;
  switch (mark) {
    case "dot":
      return <circle r={9} fill={INK} />;
    case "ring":
      return <circle r={R} className="avatar-breathe" {...stroke} />;
    case "arc":
      return (
        <g className="avatar-spin">
          <circle r={R} {...stroke} strokeOpacity={0.35} />
          <path d={`M${at(-50)}A${R} ${R} 0 0 1 ${at(60)}`} {...stroke} />
        </g>
      );
    case "notch":
      // An open ring, its gap at the top: something is missing, and it is the operator's part.
      // The gap is wide enough that the ring never reads as a power symbol.
      return <path d={`M${at(58)}A${R} ${R} 0 1 1 ${at(-58)}`} {...stroke} />;
    case "slash":
      return (
        <g {...stroke}>
          <circle r={R} />
          <path d="M-8.5 8.5L8.5 -8.5" />
        </g>
      );
    case "check":
      return <path d="M-10 0.5L-3.5 7L10 -6.5" {...stroke} strokeLinejoin="round" />;
    case "dotted":
      return (
        <circle r={R} {...stroke} strokeDasharray={`0.01 ${((2 * Math.PI * R) / 6).toFixed(2)}`} />
      );
  }
}

const BADGE_FILL: Record<NonNullable<AvatarBadge>, string> = {
  waiting: "var(--waiting)",
  blocked: "var(--blocked)",
  unread: "var(--accent)",
};

function Badge({ badge, small }: { badge: NonNullable<AvatarBadge>; small: boolean }) {
  const r = small ? 17 : 14;
  return (
    <circle
      cx={100 - r + 2}
      cy={100 - r + 2}
      r={r}
      fill={BADGE_FILL[badge]}
      // Cuts the badge out of whatever the avatar sits on.
      stroke="var(--avatar-cutout, var(--background))"
      strokeWidth={6}
    />
  );
}

/** A silhouette alone, for places that show who without a state, such as a room's avatar. */
export function AvatarShape({ avatar, size }: { avatar: Avatar; size: number }) {
  const { shape, color } = resolve(avatar);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={colorStyle(color)} aria-hidden>
      <path
        d={shape.path}
        fill="currentColor"
        stroke="var(--avatar-cutout, var(--background))"
        strokeWidth={10}
        paintOrder="stroke"
      />
    </svg>
  );
}

/** Two members' shapes overlapping: a room. */
export function RoomAvatar({ members, size }: { members: ReadonlyArray<Avatar>; size: number }) {
  const [back, front] = members;
  const part = Math.round(size * 0.68);
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {back && (
        <span className="absolute top-0 left-0">
          <AvatarShape avatar={back} size={part} />
        </span>
      )}
      {front && (
        <span className="absolute right-0 bottom-0">
          <AvatarShape avatar={front} size={part} />
        </span>
      )}
    </span>
  );
}
