// SPDX-License-Identifier: AGPL-3.0-or-later
import { useResolveClassNames } from "uniwind";

/**
 * A theme color for a prop that takes a color rather than a class, such as an
 * icon's or an SVG's fill: `className` is an `accent-` utility naming the
 * token (`accent-muted-foreground`), written out in full so Tailwind finds
 * it. Follows the theme as it changes. A class that names no color is a
 * mistake in the code, and throws.
 */
export const useColor = (className: string): string => {
  const color = useResolveClassNames(className).accentColor;
  if (color === undefined) throw new Error(`${className} names no theme color.`);
  return color;
};
