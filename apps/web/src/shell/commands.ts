// SPDX-License-Identifier: AGPL-3.0-or-later

// The shell's actions, by name, for whatever asks for them from outside the
// shell's own keys: the desktop app's menus and its global shortcut. Only
// the shell that handles the window's keys acts on them.

/**
 * `focus`: the cursor in the open conversation's composer, or on the roster
 * with none open. The others are the shell's keyboard shortcuts.
 */
export type ShellAction =
  | "focus"
  | "composer"
  | "next"
  | "previous"
  | "stop"
  | "closeDetails"
  | "settings";

const handlers = new Set<(action: ShellAction) => void>();

/** Asks the shell to do `action`. */
export function runShellAction(action: ShellAction): void {
  for (const handle of handlers) handle(action);
}

/** Calls `handle` with each action asked for; answers the function that stops. */
export function onShellAction(handle: (action: ShellAction) => void): () => void {
  handlers.add(handle);
  return () => {
    handlers.delete(handle);
  };
}
