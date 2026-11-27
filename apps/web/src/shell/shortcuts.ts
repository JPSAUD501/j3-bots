// SPDX-License-Identifier: AGPL-3.0-or-later
/** The shell's keyboard shortcuts, labeled for the platform they run on. */

/** Whether the page runs on an Apple system, whose shortcuts use ⌘ and symbols. */
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

interface Shortcut {
  /** As shown on screen. */
  readonly label: string;
  /** As `aria-keyshortcuts` expects it. */
  readonly aria: string;
  readonly matches: (event: KeyboardEvent) => boolean;
}

const modifier = (event: KeyboardEvent) => (isMac() ? event.metaKey : event.ctrlKey);

export function shellShortcuts() {
  const mac = isMac();
  return {
    stop: {
      label: mac ? "⌘." : "Ctrl+.",
      aria: mac ? "Meta+." : "Control+.",
      matches: (e) => modifier(e) && !e.shiftKey && !e.altKey && e.key === ".",
    },
    nextBot: {
      label: mac ? "⌥↓" : "Alt+↓",
      aria: "Alt+ArrowDown",
      matches: (e) => e.altKey && !modifier(e) && e.key === "ArrowDown",
    },
    previousBot: {
      label: mac ? "⌥↑" : "Alt+↑",
      aria: "Alt+ArrowUp",
      matches: (e) => e.altKey && !modifier(e) && e.key === "ArrowUp",
    },
    focusComposer: {
      label: "/",
      aria: "/",
      matches: (e) => e.key === "/" && !modifier(e) && !e.altKey,
    },
    // In the composer: no browser and no desktop takes it by default, and it
    // types nothing, unlike a letter with Alt or Option.
    dictate: {
      label: mac ? "⇧⌘Space" : "Ctrl+Shift+Space",
      aria: mac ? "Meta+Shift+Space" : "Control+Shift+Space",
      matches: (e) => modifier(e) && e.shiftKey && !e.altKey && e.code === "Space",
    },
  } satisfies Record<string, Shortcut>;
}

/** Whether typing in the event's target would be stolen by a single-key shortcut. */
export function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
