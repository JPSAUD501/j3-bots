// SPDX-License-Identifier: AGPL-3.0-or-later
import { BRIDGE_KEY, type DesktopBridge, IPC_CHANNELS } from "@j3-bots/desktop-bridge/channels";
import { contextBridge, ipcRenderer } from "electron";

// The page's one way to the main process. It passes values through as they
// are: the main process decodes what the page asks, and the page decodes what
// comes back (`HostedBridge`). It runs sandboxed, with no Node.js.

const bridge: DesktopBridge = {
  // Read once, before any script of the page runs, so the page knows its server as it starts.
  state: ipcRenderer.sendSync(IPC_CHANNELS.state),
  connect: (address) => ipcRenderer.invoke(IPC_CHANNELS.connect, { address }),
  forgetServer: () => ipcRenderer.invoke(IPC_CHANNELS.forgetServer),
  sealToken: (token) => ipcRenderer.invoke(IPC_CHANNELS.sealToken, { token }),
  openToken: (sealed) => ipcRenderer.invoke(IPC_CHANNELS.openToken, { sealed }),
  networkStatus: () => ipcRenderer.invoke(IPC_CHANNELS.network),
  onResumed: (listener) => {
    const forward = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.resumed, forward);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.resumed, forward);
    };
  },
  relaunch: () => ipcRenderer.send(IPC_CHANNELS.relaunch),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
