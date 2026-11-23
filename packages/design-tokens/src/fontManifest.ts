// SPDX-License-Identifier: AGPL-3.0-or-later
import { fontFaces } from "./tokens.ts";

/**
 * The bundled faces as JSON, for the Android and iOS build configuration:
 * Expo evaluates `app.config.ts` as CommonJS, which cannot load this
 * package's TypeScript modules, so it reads this file as it reads the icons'
 * `colors.json`.
 */
export const renderFontManifest = (): string => `${JSON.stringify(fontFaces, null, 2)}\n`;
