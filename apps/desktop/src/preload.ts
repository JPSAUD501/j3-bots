// SPDX-License-Identifier: AGPL-3.0-or-later
import { BRIDGE_KEY, type DesktopBridge, IPC_CHANNELS } from "@j3-bots/desktop-bridge/channels";
import { contextBridge, ipcRenderer } from "electron";

// The page's one way to the main process. It passes values through as they
// are: the main process decodes what the page asks, and the page decodes what
// comes back (`HostedBridge`). It runs sandboxed, with no Node.js.

const bridge: DesktopBridge = {
  // Read once, before any script of the page runs, so the page knows its server as it starts.
  state: ipcRenderer.sendSync(IPC_CHANNELS.state),
  connect: (request) => ipcRenderer.invoke(IPC_CHANNELS.connect, request),
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
  updateStatus: () => ipcRenderer.invoke(IPC_CHANNELS.update),
  onUpdate: (listener) => {
    const forward = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on(IPC_CHANNELS.updateChanged, forward);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.updateChanged, forward);
    };
  },
  checkForUpdates: () => ipcRenderer.send(IPC_CHANNELS.checkForUpdates),
  restartToUpdate: () => ipcRenderer.send(IPC_CHANNELS.restartToUpdate),
  reportSaving: (saving) => ipcRenderer.send(IPC_CHANNELS.saving, { saving }),
  notify: (request) => ipcRenderer.send(IPC_CHANNELS.notify, request),
  closeNotifications: (request) => ipcRenderer.send(IPC_CHANNELS.closeNotifications, request),
  onNotificationClick: (listener) => {
    const forward = (_event: unknown, click: unknown) => listener(click);
    ipcRenderer.on(IPC_CHANNELS.notificationClicked, forward);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.notificationClicked, forward);
    };
  },
  onAppLink: (listener) => {
    const forward = (_event: unknown, link: unknown) => listener(link);
    ipcRenderer.on(IPC_CHANNELS.appLinkOpened, forward);
    // Listening now: the main process sends the link that waited, if one did.
    ipcRenderer.send(IPC_CHANNELS.appLinksWanted);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.appLinkOpened, forward);
    };
  },
  reportLanguage: (report) => ipcRenderer.send(IPC_CHANNELS.language, report),
  reportTray: (report) => ipcRenderer.send(IPC_CHANNELS.tray, report),
  onCommand: (listener) => {
    const forward = (_event: unknown, command: unknown) => listener(command);
    ipcRenderer.on(IPC_CHANNELS.command, forward);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.command, forward);
    };
  },
  shortcutStatus: () => ipcRenderer.invoke(IPC_CHANNELS.shortcut),
  setShortcut: (accelerator) => ipcRenderer.invoke(IPC_CHANNELS.setShortcut, { accelerator }),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
