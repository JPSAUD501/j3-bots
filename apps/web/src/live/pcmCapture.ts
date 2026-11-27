// SPDX-License-Identifier: AGPL-3.0-or-later
// What the page and its recording worklet (`pcmCapture.worklet.ts`) agree on.
// Kept apart from the contracts so the worklet bundles nothing but itself.

/** The name the worklet registers its processor by, which the page creates its node with. */
export const PCM_CAPTURE = "j3-pcm-capture";

/** The rate the worklet records at: the voice socket's, `VOICE_SAMPLE_RATE`. */
export const PCM_RATE = 16_000;

/** How many samples each piece the worklet posts holds: a tenth of a second. */
export const PCM_PIECE = PCM_RATE / 10;
