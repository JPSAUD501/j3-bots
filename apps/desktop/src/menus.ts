// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Accelerator,
  DEFAULT_SHORTCUT,
  IPC_CHANNELS,
  LanguageReport,
  ShellCommand,
  type ShortcutChange,
  ShortcutRequest,
  type ShortcutStatus,
  type Theme,
  TrayReport,
} from "@j3-bots/desktop-bridge";
import { ensembleLead } from "@j3-bots/design-tokens";
import { renderStillAvatar } from "@j3-bots/design-tokens/raster";
import { createI18n, type I18n, resolveLocale } from "@j3-bots/i18n";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  app,
  type BrowserWindow,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  Tray,
} from "electron";
import type { Appearance } from "./appearance.ts";
import { DesktopSettings } from "./settings.ts";
import { trayModel } from "./trayModel.ts";

// The ways to the app from outside its page: the application menu, which
// names every action with its shortcut; the tray, which lists the bots and
// rooms that need the operator; and the global shortcut, which shows the
// window with the cursor in the composer. The page decides what each does,
// as it does for its own keys: the app only hands it the command.

const decodeLanguage = Schema.decodeUnknownOption(LanguageReport);
const decodeTray = Schema.decodeUnknownOption(TrayReport);
const decodeShortcut = Schema.decodeUnknownOption(ShortcutRequest);
const encodeCommand = Schema.encodeSync(ShellCommand);
const sameTray = Schema.toEquivalence(TrayReport);

const MAC = process.platform === "darwin";

/**
 * Whether Chromium draws on Wayland here, where a global shortcut goes through
 * the desktop's portal: on Linux, unless told to use X11, wherever a Wayland
 * display is there to use (Electron's own choice, **Assumed**).
 */
const onWayland = () => {
  if (process.platform !== "linux") return false;
  const ozone = app.commandLine.getSwitchValue("ozone-platform");
  if (ozone === "x11") return false;
  return (
    ozone === "wayland" ||
    Boolean(process.env["WAYLAND_DISPLAY"]) ||
    process.env["XDG_SESSION_TYPE"] === "wayland"
  );
};

/** A label as a menu shows it: on Linux and Windows a lone `&` marks the key that follows. */
const literal = (label: string) => (MAC ? label : label.replaceAll("&", "&&"));

/**
 * The tray's icon: the app's avatar (the ensemble's lead), with the badge that
 * says something waits, in `theme`, the one the system draws its tray in.
 */
const trayIcon = (attention: boolean, theme: Theme) => {
  const size = process.platform === "linux" ? 24 : 16;
  const look = { mark: "dot", badge: attention ? "waiting" : null } as const;
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    image.addRepresentation({
      scaleFactor,
      buffer: Buffer.from(renderStillAvatar(ensembleLead, look, theme, size * scaleFactor)),
    });
  }
  return image;
};

interface Options {
  readonly window: BrowserWindow;
  readonly appearance: Appearance;
  /** Whether an IPC message comes from the top frame of one of the app's own pages. */
  readonly fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** Restores, shows and focuses the window. */
  readonly bringForward: () => void;
}

/**
 * Puts up the application menu, the tray and the global shortcut for as long
 * as the scope lasts. The menus follow the page's language once it reports
 * it, and the system's until then; the tray lists what the page reports, and
 * nothing once the page that reported it is replaced.
 */
export const serve = Effect.fn("desktop.menus")(function* ({
  window,
  appearance,
  fromApp,
  bringForward,
}: Options) {
  const settings = yield* DesktopSettings;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const saved = (yield* settings.get).shortcut;
  const wayland = onWayland();
  // One change of shortcut at a time, so two cannot both register and leave one untracked.
  const changing = yield* Semaphore.make(1);

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      let i18n: I18n = createI18n(resolveLocale(app.getPreferredSystemLanguages()));
      let tray: TrayReport = { pairing: null, count: 0, waiting: [] };
      const icon = new Tray(trayIcon(false, appearance.systemTheme()));

      const send = (command: ShellCommand) => {
        if (window.isDestroyed()) return;
        window.webContents.send(IPC_CHANNELS.command, encodeCommand(command));
      };
      /** Brings the window forward with the cursor in the composer, or on the roster. */
      const show = () => {
        bringForward();
        send({ _tag: "focus" });
      };

      /** Whether the system took `accelerator`; a malformed one throws, which is a refusal. */
      const register = (accelerator: Accelerator) => {
        try {
          return globalShortcut.register(accelerator, show);
        } catch {
          return false;
        }
      };
      const statusOf = (accelerator: Accelerator, registered: boolean): ShortcutStatus => ({
        accelerator,
        state: registered
          ? wayland
            ? "requested"
            : "registered"
          : wayland
            ? "unavailable"
            : "taken",
      });
      let shortcut = (() => {
        const accelerator = saved ?? DEFAULT_SHORTCUT;
        return statusOf(accelerator, register(accelerator));
      })();

      const applicationMenu = () => {
        const { t } = i18n;
        /** A shortcut the page handles: shown in the menu, its keys left to the page. */
        const pageKey = (accelerator: string): Partial<MenuItemConstructorOptions> =>
          // On macOS a menu always takes its keys, which would take `/` and
          // Escape from what is typed: those two are named, not bound.
          MAC && (accelerator === "/" || accelerator === "Escape")
            ? {}
            : { accelerator, registerAccelerator: false };
        const go: MenuItemConstructorOptions[] = [
          {
            id: "show",
            label: t("desktop.menu.show"),
            accelerator: shortcut.accelerator,
            // The system holds it as the global shortcut once it took it.
            // Anywhere else the menu holds it too, for as long as the window
            // is in front: where it was refused, and on Wayland, where the
            // desktop may refuse it without telling the app.
            registerAccelerator: shortcut.state !== "registered",
            click: show,
          },
          { type: "separator" },
          {
            id: "composer",
            label: t("desktop.menu.composer"),
            ...pageKey("/"),
            click: () => send({ _tag: "composer" }),
          },
          {
            id: "next",
            label: t("desktop.menu.next"),
            ...pageKey("Alt+Down"),
            click: () => send({ _tag: "next" }),
          },
          {
            id: "previous",
            label: t("desktop.menu.previous"),
            ...pageKey("Alt+Up"),
            click: () => send({ _tag: "previous" }),
          },
          {
            id: "stop",
            label: t("desktop.menu.stop"),
            ...pageKey("CommandOrControl+."),
            click: () => send({ _tag: "stop" }),
          },
          {
            id: "closeDetails",
            label: t("desktop.menu.closeDetails"),
            ...pageKey("Escape"),
            click: () => send({ _tag: "closeDetails" }),
          },
        ];
        const template: MenuItemConstructorOptions[] = [
          {
            label: t("desktop.menu.app"),
            submenu: MAC
              ? [
                  { role: "hide", label: t("desktop.menu.hide") },
                  { role: "hideOthers", label: t("desktop.menu.hideOthers") },
                  { role: "unhide", label: t("desktop.menu.showAll") },
                  { type: "separator" },
                  { role: "quit", label: t("desktop.menu.quit") },
                ]
              : [{ role: "quit", label: t("desktop.menu.quit"), accelerator: "Control+Q" }],
          },
          {
            label: t("desktop.menu.edit"),
            submenu: [
              { role: "undo", label: t("desktop.menu.undo") },
              { role: "redo", label: t("desktop.menu.redo") },
              { type: "separator" },
              { role: "cut", label: t("desktop.menu.cut") },
              { role: "copy", label: t("desktop.menu.copy") },
              { role: "paste", label: t("desktop.menu.paste") },
              { role: "selectAll", label: t("desktop.menu.selectAll") },
            ],
          },
          { label: t("desktop.menu.go"), submenu: go },
          {
            label: t("desktop.menu.view"),
            submenu: [
              { role: "reload", label: t("desktop.menu.reload") },
              ...(app.isPackaged
                ? []
                : [{ role: "toggleDevTools", label: t("desktop.menu.devTools") } as const]),
              { type: "separator" },
              { role: "resetZoom", label: t("desktop.menu.actualSize") },
              { role: "zoomIn", label: t("desktop.menu.zoomIn") },
              { role: "zoomOut", label: t("desktop.menu.zoomOut") },
              { type: "separator" },
              { role: "togglefullscreen", label: t("desktop.menu.fullScreen") },
            ],
          },
          {
            label: t("desktop.menu.window"),
            submenu: [
              { role: "minimize", label: t("desktop.menu.minimize") },
              { role: "close", label: t("desktop.menu.close") },
              ...(MAC ? [{ role: "front", label: t("desktop.menu.front") } as const] : []),
            ],
          },
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
      };

      const trayMenu = () => {
        const model = trayModel(tray, i18n);
        const { pairing } = tray;
        const entries: MenuItemConstructorOptions[] =
          pairing === null
            ? []
            : model.entries.map(({ label, target }) => ({
                label: literal(label),
                click: () => {
                  bringForward();
                  send({ _tag: "open", target, pairing });
                },
              }));
        icon.setContextMenu(
          Menu.buildFromTemplate([
            { label: model.summary, enabled: false },
            ...entries,
            ...(model.more === null ? [] : [{ label: model.more, enabled: false }]),
            { type: "separator" },
            { label: i18n.t("desktop.menu.show"), click: show },
            { role: "quit", label: i18n.t("desktop.menu.quit") },
          ]),
        );
        icon.setToolTip(model.summary);
        icon.setImage(trayIcon(model.count > 0, appearance.systemTheme()));
        if (MAC) icon.setTitle(model.count > 0 ? String(model.count) : "");
      };

      applicationMenu();
      trayMenu();
      // On Windows a click on the tray's icon shows the window; elsewhere it opens its menu.
      icon.on("click", show);

      // A page that loads in the window's main frame replaces the one that
      // reported: what it listed goes with it, until the new page reports.
      const pageReplaced = () => {
        tray = { pairing: null, count: 0, waiting: [] };
        trayMenu();
      };
      window.webContents.on("did-navigate", pageReplaced);
      const stopFollowingTheme = appearance.onSystemTheme(() => trayMenu());

      ipcMain.on(IPC_CHANNELS.language, (event, report: unknown) => {
        const decoded = decodeLanguage(report);
        if (!fromApp(event) || Option.isNone(decoded)) return;
        if (decoded.value.language === i18n.locale) return;
        i18n = createI18n(decoded.value.language);
        applicationMenu();
        trayMenu();
      });
      ipcMain.on(IPC_CHANNELS.tray, (event, report: unknown) => {
        const decoded = decodeTray(report);
        // The page reports as its roster changes; the menu is rebuilt only
        // when what it lists does, so one open on screen stays open.
        if (!fromApp(event) || Option.isNone(decoded) || sameTray(tray, decoded.value)) return;
        tray = decoded.value;
        trayMenu();
      });
      ipcMain.handle(IPC_CHANNELS.shortcut, (event) => (fromApp(event) ? shortcut : null));
      const change = (accelerator: Accelerator): Effect.Effect<ShortcutChange> =>
        Effect.gen(function* () {
          const before = shortcut;
          const held = before.state === "registered" || before.state === "requested";
          // One that was refused is tried again when chosen again.
          if (held && accelerator === before.accelerator) {
            return { outcome: "changed", status: before };
          }
          // The new one is held before the old one goes, so a refusal keeps the old one working.
          if (!register(accelerator)) return { outcome: "taken", status: before };
          const kept = yield* settings
            .update((current) => ({
              ...current,
              shortcut: accelerator === DEFAULT_SHORTCUT ? null : accelerator,
            }))
            .pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning("Saving the shortcut failed", error).pipe(Effect.as(false)),
              ),
            );
          if (!kept) {
            globalShortcut.unregister(accelerator);
            return { outcome: "not-saved", status: before };
          }
          if (before.accelerator !== accelerator) globalShortcut.unregister(before.accelerator);
          shortcut = statusOf(accelerator, true);
          applicationMenu();
          return { outcome: "changed", status: shortcut };
        });
      ipcMain.handle(
        IPC_CHANNELS.setShortcut,
        (event, request: unknown): Promise<ShortcutChange | null> => {
          const decoded = decodeShortcut(request);
          if (!fromApp(event) || Option.isNone(decoded)) return Promise.resolve(null);
          return runPromise(changing.withPermits(1)(change(decoded.value.accelerator)));
        },
      );
      return { icon, pageReplaced, stopFollowingTheme };
    }),
    ({ icon, pageReplaced, stopFollowingTheme }) =>
      Effect.sync(() => {
        ipcMain.removeAllListeners(IPC_CHANNELS.language);
        ipcMain.removeAllListeners(IPC_CHANNELS.tray);
        ipcMain.removeHandler(IPC_CHANNELS.shortcut);
        ipcMain.removeHandler(IPC_CHANNELS.setShortcut);
        stopFollowingTheme();
        if (!window.isDestroyed()) window.webContents.off("did-navigate", pageReplaced);
        globalShortcut.unregisterAll();
        icon.destroy();
      }),
  );
});
