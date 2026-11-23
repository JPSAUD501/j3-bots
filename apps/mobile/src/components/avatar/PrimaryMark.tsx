// SPDX-License-Identifier: AGPL-3.0-or-later
import { Star } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { Icon } from "../Icon.tsx";
import type { AvatarGround } from "./BotAvatar.tsx";

const groundFill = {
  background: "bg-background",
  surface: "bg-surface",
  muted: "bg-muted",
} as const satisfies Record<AvatarGround, string>;

/**
 * The mark's size for an avatar `size` px across: the disc, never under
 * 14 px so the star reads, and the band of ground around it.
 */
const primaryMarkSize = (size: number) => {
  const disc = Math.max(14, Math.round(size * 0.34));
  const band = size >= 56 ? 3 : 2;
  return { disc, band, outer: disc + 2 * band };
};

/**
 * The primary bot's mark: a star on an `accent` disc at the avatar's lower
 * end corner, cut out of the body by a band of what the avatar sits on, the
 * way a state's light is. The band keeps it apart from every body color in
 * both themes, and the disc is the text color, so it reads as the chrome's
 * own sign rather than a bot's color. The antenna stays the status light: the
 * mark says who the bot is, never what it is doing. Screen readers hear it in
 * the label of what holds the avatar.
 */
export function PrimaryMark({
  size,
  ground = "background",
  children,
}: {
  /** The avatar's size, in px. */
  readonly size: number;
  readonly ground?: AvatarGround | undefined;
  /** The avatar. */
  readonly children: ReactNode;
}) {
  const { disc, outer } = primaryMarkSize(size);
  // Centred a little inside the corner, so it overlaps the body's edge like a badge on a photo.
  const inset = size * 0.16 - outer / 2;
  return (
    <View style={{ width: size, height: size }}>
      {children}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        className={`absolute items-center justify-center rounded-pill ${groundFill[ground]}`}
        style={{ width: outer, height: outer, bottom: inset, end: inset }}
      >
        <View
          className="items-center justify-center rounded-pill bg-accent"
          style={{ width: disc, height: disc }}
        >
          <Icon
            icon={Star}
            size={Math.round(disc * 0.62)}
            color="accent-accent-foreground"
            filled
          />
        </View>
      </View>
    </View>
  );
}
