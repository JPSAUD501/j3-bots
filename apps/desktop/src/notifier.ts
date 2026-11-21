// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloseNotificationsRequest,
  IPC_CHANNELS,
  NotificationClick,
  NotificationRequest,
} from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  app,
  type BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  nativeImage,
  Notification,
} from "electron";
import { type Display, makeNotifications } from "./notifications.ts";

// Native notifications: the page decides what to show, as in a browser, and
// the main process shows it with the system's own notifications, so a click
// can bring the window forward wherever it is.

const decodeRequest = Schema.decodeUnknownOption(NotificationRequest);
const decodeClose = Schema.decodeUnknownOption(CloseNotificationsRequest);
const encodeClick = Schema.encodeSync(NotificationClick);

interface Options {
  readonly window: BrowserWindow;
  /** Whether an IPC message comes from the top frame of one of the app's own pages. */
  readonly fromApp: (event: IpcMainEvent) => boolean;
  /** Restores, shows and focuses the window. */
  readonly bringForward: () => void;
  /** The PNG file a notification with no avatar of its own shows: the app's icon. */
  readonly appIcon: string;
}

/**
 * Shows the notifications the window's page asks for, for as long as the
 * scope lasts. They live with the page that showed them: every one closes as
 * the page is replaced (a reload, or the server forgotten) and as the app
 * quits, since only that page knows when its pairing ends, and once it is gone
 * a click would open nothing.
 */
export const listen = ({ window, fromApp, bringForward, appIcon }: Options) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const fallback = nativeImage.createFromPath(appIcon);
      const display: Display = (request, on) => {
        if (!Notification.isSupported()) return null;
        const avatar =
          request.icon === null
            ? null
            : nativeImage.createFromBuffer(
                Buffer.from(request.icon.buffer, request.icon.byteOffset, request.icon.byteLength),
              );
        const notification = new Notification({
          title: request.title,
          body: request.body,
          icon: avatar === null || avatar.isEmpty() ? fallback : avatar,
        });
        notification.on("click", on.clicked);
        notification.on("close", on.gone);
        notification.on("failed", on.gone);
        notification.show();
        return notification;
      };
      const notifications = makeNotifications(display, (click) => {
        if (window.isDestroyed()) return;
        bringForward();
        window.webContents.send(IPC_CHANNELS.notificationClicked, encodeClick(click));
      });
      const pageReplaced = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) notifications.closeAll();
      };
      window.webContents.on("did-start-navigation", pageReplaced);
      app.on("will-quit", notifications.closeAll);
      ipcMain.on(IPC_CHANNELS.notify, (event, request: unknown) => {
        const decoded = decodeRequest(request);
        if (fromApp(event) && Option.isSome(decoded)) notifications.show(decoded.value);
      });
      ipcMain.on(IPC_CHANNELS.closeNotifications, (event, request: unknown) => {
        const decoded = decodeClose(request);
        if (fromApp(event) && Option.isSome(decoded)) notifications.closeOf(decoded.value.pairing);
      });
      return { notifications, pageReplaced };
    }),
    ({ notifications, pageReplaced }) =>
      Effect.sync(() => {
        ipcMain.removeAllListeners(IPC_CHANNELS.notify);
        ipcMain.removeAllListeners(IPC_CHANNELS.closeNotifications);
        app.off("will-quit", notifications.closeAll);
        if (!window.isDestroyed()) window.webContents.off("did-start-navigation", pageReplaced);
        notifications.closeAll();
      }),
  ).pipe(Effect.asVoid);
