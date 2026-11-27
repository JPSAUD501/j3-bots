// SPDX-License-Identifier: AGPL-3.0-or-later
// The `Engine` over a real T3 Code server: install, provision, supervise, connect.
import { pin } from "./t3/Pin.ts";

export { layer } from "./t3/T3Engine.ts";
export {
  EngineInstallFailed,
  type EngineInstall,
  type DownloadEvent,
  downloadText,
  fetchPinned,
  inspectInstall,
  makeProgressLog,
  progressText,
  pruneRuntimes,
} from "./t3/Install.ts";
export { type BrowserHostNeeds, inspectBrowserHost } from "./t3/BrowserHost.ts";
export { stateFiles } from "./t3/State.ts";
export { writtenFolders } from "./t3/PrivateFiles.ts";
export { activeConnection } from "./t3/Provision.ts";
export { engineEnvironment } from "./t3/Command.ts";

/** The engine release this adapter installs and runs. */
export const pinnedRelease: string = pin.version;
