// SPDX-License-Identifier: AGPL-3.0-or-later
// First, so every module after it finds what the shared packages use.
import "./src/polyfills.ts";
import { registerRootComponent } from "expo";
import { App } from "./src/App.tsx";
import { session } from "./src/platform/platform.ts";
import { applyAppearance } from "./src/preferences.ts";
import { receiveShares } from "./src/share/incoming.ts";

applyAppearance();
void session.start();
receiveShares();
registerRootComponent(App);
