// SPDX-License-Identifier: AGPL-3.0-or-later
// The look of every dialog, shared so they open and close alike. Base UI marks
// a popup's first and last frames (`data-starting-style`, `data-ending-style`);
// the popup moves in on a spring and leaves on the quicker `out` ease, so a
// closed dialog never lingers. Reduced motion drops the moves (index.css).

/** The scrim behind a dialog, fading in and out with it. */
export const dialogBackdrop =
  "fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-slow) ease-out data-ending-style:opacity-0 data-starting-style:opacity-0";

/**
 * A short question or form, centered: it pops in from slightly smaller and
 * shrinks away. Its width and padding are the caller's.
 */
export const alertDialog =
  "fixed inset-x-4 top-1/2 z-40 mx-auto flex -translate-y-1/2 flex-col rounded-xl border border-border bg-surface text-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-state) data-ending-style:ease-out";

/**
 * A dialog that takes the whole screen on a phone, rising from the bottom and
 * sinking back, and is a panel from the tablet layout up, which rises a little
 * as it fades in. The caller adds the panel's top, bottom and width.
 */
export const screenDialog =
  "fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground outline-none transition-[translate,scale,opacity] duration-(--duration-slide) ease-slide data-starting-style:translate-y-full data-ending-style:translate-y-full data-ending-style:duration-(--duration-state) data-ending-style:ease-out tablet:inset-x-4 tablet:mx-auto tablet:rounded-xl tablet:border tablet:border-border tablet:bg-surface tablet:shadow-overlay tablet:duration-(--duration-soft) tablet:ease-soft tablet:data-starting-style:translate-y-6 tablet:data-starting-style:scale-[0.98] tablet:data-starting-style:opacity-0 tablet:data-ending-style:translate-y-3 tablet:data-ending-style:opacity-0";

/** A dialog's title, in the display face. */
export const dialogTitle = "display-type text-xl text-foreground";
