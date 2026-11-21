// SPDX-License-Identifier: AGPL-3.0-or-later
import "@fontsource-variable/inter";
import "./index.css";

import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktop } from "./live/desktop";
import { listenForNotificationClicks } from "./live/notify";
import { LinkedPairingCode, linkedCode, takePairingCode } from "./live/pairingLink";
import { makeRouter } from "./router";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element.");

// Keeps the app shell for offline launch (pwa/serviceWorker.ts). Development
// has none, browsers offer none outside a secure context (HTTPS, or
// localhost), and the desktop app ships the shell itself.
if (import.meta.env.PROD && desktop === null && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // The app works without it; it only cannot open offline.
      // @effect-diagnostics-next-line globalConsole:off
      console.warn("The service worker did not register.", error);
    });
  });
}

// Before the page finishes loading: a window the service worker opened for a
// notification click is handed the click then.
listenForNotificationClicks(desktop);

// A build replaced while this page was open has deleted the scripts it would load
// next; loading the page again picks up the new build.
window.addEventListener("vite:preloadError", () => window.location.reload());

// A pairing link's page (`/pair`) leaves the address bar before the router reads
// it. The desktop app's page is its own, never a link's.
const linked = linkedCode(
  desktop === null ? takePairingCode(window.location.href, window.history) : null,
  window,
);
const router = makeRouter();

createRoot(root).render(
  <StrictMode>
    <LinkedPairingCode value={linked}>
      <RouterProvider router={router} />
    </LinkedPairingCode>
  </StrictMode>,
);
