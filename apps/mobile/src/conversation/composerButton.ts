// SPDX-License-Identifier: AGPL-3.0-or-later
import { layout } from "@j3-bots/design-tokens";

/** The circle of the composer's round buttons, in px: `size-8`. */
const CIRCLE = 32;
const around = (layout.touchTarget - CIRCLE) / 2;

/**
 * The box a round button of the composer stands in: a touch target square
 * around its circle. It sits beside the field's last line, which is a touch
 * target tall, however far the field has grown; boxes side by side touch
 * without overlapping, so each button keeps its whole target.
 */
export const composerButtonFrame = { padding: around } as const;

/** What a round button of the composer takes beyond its circle: its box, to the edge. */
export const composerButtonSlop = around;
