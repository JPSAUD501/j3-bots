// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BRIDGE_KEY,
  type DesktopBridge,
  IPC_CHANNELS,
  UPLOAD_TAGS,
  type UploadHandle,
} from "@j3-bots/desktop-bridge/channels";
import { contextBridge, ipcRenderer } from "electron";

// The page's one way to the main process. It passes values through as they
// are: the main process decodes what the page asks, and the page decodes what
// comes back (`HostedBridge`). It runs sandboxed, with no Node.js.

/** How much of a file goes in one message to the main process. */
const CHUNK = 256 * 1024;

/**
 * Sends `body` to the main process over a port of its own, a chunk each time
 * the main process asks for one, so no more than a chunk of it is in flight.
 */
const upload = (
  request: unknown,
  body: Blob,
  onProgress: (sent: unknown) => void,
): UploadHandle => {
  if (!(body instanceof Blob)) {
    return { done: Promise.resolve({ _tag: UPLOAD_TAGS.failed }), abort: () => undefined };
  }
  const { port1: port, port2 } = new MessageChannel();
  let offset = 0;
  const done = new Promise<unknown>((resolve) => {
    const finish = (outcome: unknown) => {
      port.close();
      resolve(outcome);
    };
    port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== "object" || data === null) return finish(data);
      const tag: unknown = Reflect.get(data, "_tag");
      if (tag === UPLOAD_TAGS.progress) return onProgress(Reflect.get(data, "sent"));
      if (tag !== UPLOAD_TAGS.pull) return finish(data);
      const start = offset;
      offset = Math.min(body.size, start + CHUNK);
      if (start >= body.size) return port.postMessage({ _tag: UPLOAD_TAGS.end });
      body
        .slice(start, offset)
        .arrayBuffer()
        .then(
          (bytes) => port.postMessage({ _tag: UPLOAD_TAGS.chunk, bytes: new Uint8Array(bytes) }),
          () => finish({ _tag: UPLOAD_TAGS.failed }),
        );
    };
  });
  ipcRenderer.postMessage(IPC_CHANNELS.upload, { request, size: body.size }, [port2]);
  return { done, abort: () => port.close() };
};

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
  upload,
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
