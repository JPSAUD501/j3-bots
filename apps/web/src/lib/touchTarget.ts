// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Grows a control's hit area to the minimum touch target on touch screens,
 * without changing its drawn size. The control must not clip its overflow.
 */
export const touchTarget =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-[min(0px,calc((100%-var(--layout-touch-target))/2))]";
