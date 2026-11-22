// SPDX-License-Identifier: AGPL-3.0-or-later
// First, so every module after it finds what the shared packages use.
import "./src/polyfills.ts";
import { registerRootComponent } from "expo";
import * as SplashScreen from "expo-splash-screen";
import { App } from "./src/App.tsx";
import { session } from "./src/platform/platform.ts";
import { applyAppearance } from "./src/preferences.ts";
import { receiveShares } from "./src/share/incoming.ts";

// The splash screen stays until the first screen has drawn in the operator's
// theme (App.tsx), which is set before anything renders. If it cannot be
// kept, it hides as the app first renders: nothing to handle.
SplashScreen.preventAutoHideAsync().catch(() => undefined);
applyAppearance();
void session.start();
receiveShares();
registerRootComponent(App);
