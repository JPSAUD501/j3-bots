// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LucideIcon } from "lucide-react-native";
import { useColor } from "../theme.ts";

/**
 * A Lucide icon in a theme color, hidden from screen readers: the control
 * around it carries the name. `color` is an `accent-` utility, as `useColor`
 * takes.
 */
export function Icon({
  icon: Drawn,
  color,
  size = 16,
  filled = false,
}: {
  readonly icon: LucideIcon;
  readonly color: string;
  readonly size?: number;
  /** Fills the drawing too, as a Stop square. */
  readonly filled?: boolean;
}) {
  const resolved = useColor(color);
  return (
    <Drawn
      size={size}
      color={resolved}
      fill={filled ? resolved : "none"}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
