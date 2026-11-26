// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A chip set in a line of message text, as a file or a bot's mention: the
 * line height of a paragraph that holds one, which makes room for it, and the
 * chip's height and how far below the text's baseline its foot goes, so that
 * it stands centered on the line: React Native sets a view inside text with
 * its foot on the baseline.
 */
export const INLINE_LINE_HEIGHT = 32;

export const inlineChip = { height: 24, transform: [{ translateY: 6 }] } as const;
