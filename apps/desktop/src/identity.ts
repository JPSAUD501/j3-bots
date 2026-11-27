// SPDX-License-Identifier: AGPL-3.0-or-later
import { DESKTOP_APP_ORIGINS } from "@j3-bots/contracts";

/**
 * The app's id for the operating system: Windows notifications, and the
 * package (`appId` in electron-builder.yml).
 */
export const APP_ID = "dev.j3bots.desktop";

/**
 * The origin the app's pages have: `j3bots://app` in a packaged build,
 * `j3bots-dev://app` in development, so the two never share a profile's
 * storage. The server answers CORS for exactly these (`DESKTOP_APP_ORIGINS`).
 */
export const appOrigin = (packaged: boolean): string =>
  packaged ? DESKTOP_APP_ORIGINS.production : DESKTOP_APP_ORIGINS.development;

/** The custom scheme of `origin`, without its colon. */
export const schemeOf = (origin: string): string => new URL(origin).protocol.slice(0, -1);
