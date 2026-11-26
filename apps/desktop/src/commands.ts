// SPDX-License-Identifier: AGPL-3.0-or-later
import { IPC_CHANNELS, ShellCommand } from "@j3-bots/desktop-bridge";
import * as Schema from "effect/Schema";
import type { BrowserWindow } from "electron";

const encodeCommand = Schema.encodeSync(ShellCommand);

/**
 * Hands the main window's page a command, from the app's menus, its tray or
 * quick access. The page decides what each does, as it does for its own keys.
 */
export const commandSender =
  (window: BrowserWindow) =>
  (command: ShellCommand): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC_CHANNELS.command, encodeCommand(command));
  };
