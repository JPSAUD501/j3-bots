// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the app's page may ask of the system: showing notifications, writing
 * to the clipboard, and the microphone alone, which dictation and a screen
 * recording hear. Never a camera, a screen, or audio together with video:
 * the screens go only to the recorder's control (`capturesScreens`).
 */

type MediaType = "video" | "audio" | "unknown";

const ALWAYS = new Set(["notifications", "clipboard-sanitized-write"]);

/** Whether a request for `permission`, asking for `mediaTypes` when it is `media`, is granted. */
export const grants = (
  permission: string,
  mediaTypes: ReadonlyArray<MediaType> | undefined,
): boolean =>
  ALWAYS.has(permission) ||
  (permission === "media" &&
    mediaTypes !== undefined &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio"));

/** Whether the page already holds `permission`, for `mediaType` when it is `media`. */
export const holds = (permission: string, mediaType: MediaType | undefined): boolean =>
  ALWAYS.has(permission) || (permission === "media" && mediaType === "audio");
