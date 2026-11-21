// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTP_PATHS, MAX_ATTACHMENT_SIZE } from "@j3-bots/contracts";
import type { ServerOrigin, UploadStart } from "@j3-bots/desktop-bridge";

/**
 * Whether `url` is the attachments route of `server`, the one place the page
 * uploads to. Its query names the file; a fragment never leaves the app. A
 * user name or password in it would go to the server as credentials the page
 * chose, so it is refused.
 */
export const isUploadUrl = (url: string, server: ServerOrigin | null): boolean => {
  const parsed = URL.parse(url);
  return (
    server !== null &&
    parsed !== null &&
    parsed.origin === server &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === HTTP_PATHS.attachments
  );
};

/** Whether the upload `start` asks for may begin, while the app keeps `server`. */
export const mayUpload = (start: UploadStart, server: ServerOrigin | null): boolean =>
  isUploadUrl(start.request.url, server) && start.size <= MAX_ATTACHMENT_SIZE;
