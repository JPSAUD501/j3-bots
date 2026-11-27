// SPDX-License-Identifier: AGPL-3.0-or-later
// First, so every module after it finds what the shared packages use.
import "./src/polyfills.ts";
import { registerRootComponent } from "expo";
import { AppRegistry } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { App } from "./src/App.tsx";
import { session } from "./src/platform/platform.ts";
import { keepPushRegistered, setUpNotifications } from "./src/platform/push.ts";
import { applyAppearance } from "./src/preferences.ts";
import { applyKeptLook } from "./src/themes/look.ts";
import { ShareRoot } from "./src/share/ShareSheet.tsx";
import { keepShareTargets } from "./src/share/shortcuts.ts";
import { receiveViewedTemplates } from "./src/template/opened.ts";
import { keepWidgetsFed } from "./src/widget/feed.ts";
import { WidgetSetupRoot } from "./src/widget/WidgetSetup.tsx";

// The splash screen stays until the first screen has drawn in the operator's
// theme (App.tsx), which is set before anything renders. If it cannot be
// kept, it hides as the app first renders: nothing to handle.
SplashScreen.preventAutoHideAsync().catch(() => undefined);
applyAppearance();
applyKeptLook();
setUpNotifications(session);
void session.start();
keepPushRegistered(session);
keepShareTargets(session);
keepWidgetsFed(session);
receiveViewedTemplates();
registerRootComponent(App);
// What Android opens over other apps, in windows of their own that share this
// JavaScript: the share sheet, and the setup of a home-screen widget.
AppRegistry.registerComponent("J3Share", () => ShareRoot);
AppRegistry.registerComponent("J3WidgetSetup", () => WidgetSetupRoot);
