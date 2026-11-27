// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DiagnosticsClient, diagnosticsFileName } from "@j3-bots/contracts";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import * as DateTime from "effect/DateTime";
import type { DiagnosticsIntents } from "../shell/data";
import { desktop } from "./desktop";
import { useDesktopUpdate } from "./appUpdate";
import { saveBytes } from "./openFile";

/** The system this page runs on, as far as its user agent says. */
const osOf = (userAgent: string): DiagnosticsClient["os"] =>
  /Android/.test(userAgent)
    ? "android"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "ios"
      : /Windows/.test(userAgent)
        ? "windows"
        : /Macintosh|Mac OS X/.test(userAgent)
          ? "macos"
          : /Linux|X11/.test(userAgent)
            ? "linux"
            : "other";

/**
 * The server's diagnostics zip for Settings → About, saved through the
 * browser's download; absent while the server has not said it makes one,
 * and from a server that makes none. The zip names this client: the desktop
 * app with its version, or the web client, which runs the server's own.
 */
export function useDiagnostics(): DiagnosticsIntents | undefined {
  const j3 = useJ3Client();
  const server = useReadable(j3.server);
  const app = useDesktopUpdate();
  if (server?.diagnostics === undefined) return undefined;
  const client: DiagnosticsClient = {
    surface: desktop === null ? "web" : "desktop",
    version: desktop === null ? null : (app?.status.current ?? null),
    os: osOf(navigator.userAgent),
  };
  return {
    save: () =>
      j3.downloadDiagnostics(client).then((result) => {
        if (result._tag !== "done") return false;
        saveBytes(diagnosticsFileName(DateTime.nowUnsafe()), result.value.bytes);
        return true;
      }),
  };
}
