// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, BotState } from "@j3-bots/contracts";
import {
  avatarBadges,
  avatarMarks,
  avatarMarkStroke,
  avatarProportions,
  avatarShapes,
  resolveAvatar,
  type AvatarMarkName,
  type AvatarMarkPart,
  type BotColor,
} from "@j3-bots/design-tokens";
import type { CSSProperties } from "react";
import { avatarAppearance } from "@j3-bots/client-runtime/presentation";
import { useChanges } from "../lib/useChanges";

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
  const { shape: shapeName, color } = resolveAvatar(avatar);
  const shape = avatarShapes[shapeName];
  const look = avatarAppearance(state, unread);
  const { markScale, badge } = avatarProportions(size);
  // Keys on the count of changes restart the one-time animations on each change.
  const changes = useChanges(look.mark);
  const changed = changes > 0;
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
          <Mark mark={look.mark} motion={MOTION_CLASS[look.motion]} />
        </g>
      </g>
      {look.badge && (
        <circle
          cx={badge.center}
          cy={badge.center}
          r={badge.r}
          fill={`var(--${avatarBadges[look.badge]})`}
          // Cuts the badge out of whatever the avatar sits on.
          stroke="var(--avatar-cutout, var(--background))"
          strokeWidth={badge.cutout}
        />
      )}
    </svg>
  );
}

const MOTION_CLASS = { none: undefined, breathe: "avatar-breathe", spin: "avatar-spin" } as const;

const INK = "var(--avatar-ink)";

/** The mark's parts, moving as one. */
function Mark({ mark, motion }: { mark: AvatarMarkName; motion: string | undefined }) {
  const parts: ReadonlyArray<AvatarMarkPart> = avatarMarks[mark];
  return (
    <g className={motion}>
      {parts.map((part, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional: a mark's data never reorders
        <MarkPart key={i} part={part} />
      ))}
    </g>
  );
}

const STROKE = {
  fill: "none",
  stroke: INK,
  strokeWidth: avatarMarkStroke,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function MarkPart({ part }: { part: AvatarMarkPart }) {
  switch (part.kind) {
    case "disc":
      return <circle r={part.r} fill={INK} />;
    case "circle":
      return (
        <circle
          r={part.r}
          {...STROKE}
          strokeOpacity={part.opacity}
          strokeDasharray={part.dash?.join(" ")}
        />
      );
    case "path":
      return <path d={part.d} {...STROKE} />;
  }
}

/** A silhouette alone, for places that show who without a state, such as a room's avatar. */
export function AvatarShape({ avatar, size }: { avatar: Avatar; size: number }) {
  const { shape, color } = resolveAvatar(avatar);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={colorStyle(color)} aria-hidden>
      <path
        d={avatarShapes[shape].path}
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
