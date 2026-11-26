// SPDX-License-Identifier: AGPL-3.0-or-later
import { app } from "electron";

/**
 * Whether Chromium draws on Wayland here, where a global shortcut goes through
 * the desktop's portal and a window's place and its standing above the others
 * are the compositor's to decide: on Linux, unless told to use X11, wherever
 * a Wayland display is there to use (Electron's own choice, **Assumed**).
 */
export const onWayland = (): boolean => {
  if (process.platform !== "linux") return false;
  const ozone = app.commandLine.getSwitchValue("ozone-platform");
  if (ozone === "x11") return false;
  return (
    ozone === "wayland" ||
    Boolean(process.env["WAYLAND_DISPLAY"]) ||
    process.env["XDG_SESSION_TYPE"] === "wayland"
  );
};
