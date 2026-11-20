// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Makes a control at least the minimum touch target on touch screens: its
 * real box grows, so controls laid side by side, or wrapped onto a second
 * line, keep their gap and never cover one another. Fine pointers keep the
 * compact size.
 */
export const touchTarget =
  "pointer-coarse:min-h-(--layout-touch-target) pointer-coarse:min-w-(--layout-touch-target)";
