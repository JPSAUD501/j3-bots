// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A text field: filled, with no outline of its own until it has focus, when it
 * takes the focus ring. A field the operator got wrong takes the `blocked`
 * border. Its label and its text or placeholder, both at the text contrast,
 * say it is a field. The caller sets its height or rows.
 */
export const textField =
  "w-full rounded-md border border-transparent bg-muted px-3 text-sm text-foreground placeholder:text-muted-foreground transition-[background-color,border-color] duration-(--duration-fast) ease-out hover:bg-muted-strong focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-accent read-only:text-muted-foreground read-only:hover:bg-muted aria-invalid:border-blocked";

/** A one-line field: the control height, and the touch target on a touch screen. */
export const lineField = `${textField} h-9 pointer-coarse:h-11`;
