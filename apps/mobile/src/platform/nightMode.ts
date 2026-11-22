// SPDX-License-Identifier: AGPL-3.0-or-later
import { requireOptionalNativeModule } from "expo";
import type { Appearance } from "../preferences.ts";

/** The app's own module (`modules/app-night-mode`), on Android only. */
const nightMode = requireOptionalNativeModule<{ set(appearance: Appearance): void }>(
  "AppNightMode",
);

/**
 * Tells the system the appearance the operator chose, so it draws the app's
 * next splash screen in it. Only Android 12 and later keep one per app; iOS
 * draws its launch screen in the system's theme.
 */
export const keepNightMode = (appearance: Appearance): void => nightMode?.set(appearance);
