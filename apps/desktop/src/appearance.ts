// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AppearanceReport,
  IPC_CHANNELS,
  type Theme,
  type ThemeWindowColors,
} from "@j3-bots/desktop-bridge";
import { colors } from "@j3-bots/design-tokens";
import { hexColor } from "@j3-bots/design-tokens/raster";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  nativeTheme,
  systemPreferences,
} from "electron";
import { DesktopSettings } from "./settings.ts";

// Light and dark. The page keeps the operator's appearance and reports it;
// the app keeps the last one reported, so the next launch's window, its title
// bar and its menus take it before the page paints. Electron's `themeSource`
// is what reaches the title bar, and it makes `nativeTheme` answer with the
// app's theme. The page does not rely on it: it applies the appearance it
// keeps before it paints, and on Linux `themeSource` does not reach its
// `prefers-color-scheme` at all. The page reports its theme's window colors
// with it (decision 0104), kept the same way, so a window fills with the
// theme's canvas, not the stock one, before the page paints. What the system
// draws itself, its notifications and its tray or menu bar, stays in the
// system's theme, which the app then reads apart (`systemTheme`).

const decodeReport = Schema.decodeUnknownOption(AppearanceReport);

/**
 * What a window fills with in `theme`, so nothing else shows before its page
 * paints: the theme's colors the page reported, or the stock ones.
 */
const fill = (kept: ThemeWindowColors | null, theme: Theme) =>
  kept?.[theme] ?? {
    background: hexColor(colors.background[theme]),
    surface: hexColor(colors.surface[theme]),
  };

const sameColors = (a: ThemeWindowColors | null, b: ThemeWindowColors | null) =>
  a === null || b === null
    ? a === b
    : (["light", "dark"] as const).every(
        (theme) =>
          a[theme].background === b[theme].background && a[theme].surface === b[theme].surface,
      );

const themeOf = (dark: boolean): Theme => (dark ? "dark" : "light");

export interface Appearance {
  /** The window's background now: the page's canvas in the theme the window is in. */
  readonly windowBackground: () => string;
  /** Quick access's card now, which a window that is not see-through fills with. */
  readonly cardBackground: () => string;
  /** Calls `listener` each time the windows' colors may have changed; answers a function that stops it. */
  readonly onColors: (listener: () => void) => () => void;
  /** Takes the colors of the theme the page shows, null for the stock ones. */
  readonly setColors: (colors: ThemeWindowColors | null) => void;
  /** The theme the system draws its own notifications and its tray or menu bar in. */
  readonly systemTheme: () => Theme;
  /** Calls `listener` each time `systemTheme` may have changed; answers a function that stops it. */
  readonly onSystemTheme: (listener: () => void) => () => void;
}

/**
 * Applies the appearance kept from the last launch, before any window opens,
 * and follows the system's theme for as long as the scope lasts.
 */
export const start = Effect.fn("desktop.appearance.start")(function* () {
  const settings = yield* DesktopSettings;
  // Read before the kept choice overrides it: until then `nativeTheme` follows the system.
  let systemDark = nativeTheme.shouldUseDarkColors;
  const kept = yield* settings.get;
  nativeTheme.themeSource = kept.appearance;
  let windowColors = kept.windowColors;
  const colorListeners = new Set<() => void>();
  const colorsChanged = () => {
    for (const listener of colorListeners) listener();
  };

  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  /**
   * Windows tells the system's theme apart from the apps' one; macOS keeps it
   * in the user's defaults. Linux has no such reading: there it is what
   * `nativeTheme` last said while it followed the system, so a change of the
   * system's theme while the operator chose one is seen once the app follows
   * the system again, or at the next launch.
   */
  const systemTheme = (): Theme => {
    switch (process.platform) {
      case "win32":
        return themeOf(nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
      case "darwin":
        return themeOf(
          systemPreferences.getUserDefault("AppleInterfaceStyle", "string") === "Dark",
        );
      default:
        return themeOf(systemDark);
    }
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const updated = () => {
        if (nativeTheme.themeSource === "system") systemDark = nativeTheme.shouldUseDarkColors;
        changed();
        colorsChanged();
      };
      nativeTheme.on("updated", updated);
      // macOS announces a change of its theme even while the app overrides it.
      const subscription =
        process.platform === "darwin"
          ? systemPreferences.subscribeNotification(
              "AppleInterfaceThemeChangedNotification",
              changed,
            )
          : null;
      return { updated, subscription };
    }),
    ({ updated, subscription }) =>
      Effect.sync(() => {
        nativeTheme.off("updated", updated);
        if (subscription !== null) systemPreferences.unsubscribeNotification(subscription);
      }),
  );

  const now = () => fill(windowColors, themeOf(nativeTheme.shouldUseDarkColors));

  return {
    windowBackground: () => now().background,
    cardBackground: () => now().surface,
    onColors: (listener) => {
      colorListeners.add(listener);
      return () => {
        colorListeners.delete(listener);
      };
    },
    setColors: (next) => {
      windowColors = next;
      colorsChanged();
    },
    systemTheme,
    onSystemTheme: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies Appearance;
});

interface Options {
  readonly window: BrowserWindow;
  readonly appearance: Appearance;
  /** Whether an IPC message comes from the top frame of one of the app's own pages. */
  readonly fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
}

/**
 * Takes the page's reports of the operator's appearance, keeping each new one
 * for the next launch, and keeps the window's background on the page's canvas
 * as the theme changes, so a resize or a reload never shows another color.
 */
export const serve = Effect.fn("desktop.appearance.serve")(function* ({
  window,
  appearance,
  fromApp,
}: Options) {
  const settings = yield* DesktopSettings;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const keep = Effect.fn("desktop.appearance.keep")(function* (report: AppearanceReport) {
    nativeTheme.themeSource = report.appearance;
    const windowColors = report.colors ?? null;
    appearance.setColors(windowColors);
    const current = yield* settings.get;
    if (
      current.appearance === report.appearance &&
      sameColors(current.windowColors, windowColors)
    ) {
      return;
    }
    yield* settings
      .update((before) => ({ ...before, appearance: report.appearance, windowColors }))
      .pipe(Effect.catch((error) => Effect.logWarning("Keeping the appearance failed", error)));
  });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.on(IPC_CHANNELS.appearance, (event, report: unknown) => {
        const decoded = decodeReport(report);
        if (!fromApp(event) || Option.isNone(decoded)) return;
        void runPromise(keep(decoded.value));
      });
      ipcMain.handle(IPC_CHANNELS.systemTheme, (event) =>
        fromApp(event) ? appearance.systemTheme() : null,
      );
      return appearance.onColors(() => {
        if (!window.isDestroyed()) window.setBackgroundColor(appearance.windowBackground());
      });
    }),
    (stopRepainting) =>
      Effect.sync(() => {
        ipcMain.removeAllListeners(IPC_CHANNELS.appearance);
        ipcMain.removeHandler(IPC_CHANNELS.systemTheme);
        stopRepainting();
      }),
  );
});
