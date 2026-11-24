// SPDX-License-Identifier: AGPL-3.0-or-later
import { layout } from "@j3-bots/design-tokens";

/** The circle of the composer's round buttons, in px: `size-8`. */
const CIRCLE = 32;
const around = (layout.touchTarget - CIRCLE) / 2;

/**
 * Where a round button of the composer stands: centred beside the field's
 * last line, as a single line is a touch target tall, however far the field
 * has grown.
 */
export const composerButtonFrame = { marginBottom: around } as const;

/** What a round button of the composer takes beyond its circle: a full touch target. */
export const composerButtonSlop = around;
