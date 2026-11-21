// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Attachment } from "@j3-bots/contracts";

/**
 * Types a browser shows without running anything in the page's origin. A
 * file of any other type, HTML and SVG included, could run script with the
 * device's credential within reach, so it is saved and never opened here.
 */
const SHOWN = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);

/** A window opened while the operator's click still counts, for the file to load into. */
export const reserveWindow = (attachment: Attachment): Window | null =>
  SHOWN.has(attachment.mediaType) ? window.open("", "_blank") : null;

/**
 * Shows a file the browser can show in the window reserved for it, and saves
 * any other, or any the browser kept from opening a window.
 */
export function deliverFile(
  attachment: Attachment,
  bytes: Uint8Array<ArrayBuffer>,
  reserved: Window | null,
) {
  const typed = new Blob([bytes], {
    type: SHOWN.has(attachment.mediaType) ? attachment.mediaType : "application/octet-stream",
  });
  const url = URL.createObjectURL(typed);
  if (reserved !== null) {
    reserved.location.href = url;
  } else {
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.name;
    link.rel = "noopener";
    link.click();
  }
  // The window or the download has the bytes by then.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
