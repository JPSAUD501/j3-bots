// SPDX-License-Identifier: AGPL-3.0-or-later
import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// The type scale replaces Tailwind's, so tailwind-merge must know its names
// to tell a size (`text-2xs`) from a color.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["2xs", "xs", "sm", "base", "lg", "xl"] } },
});

export function cn(...inputs: CxOptions): string {
  return twMerge(cx(inputs));
}
