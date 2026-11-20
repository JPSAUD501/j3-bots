// SPDX-License-Identifier: AGPL-3.0-or-later
import "@fontsource-variable/inter";
import "./index.css";

import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element.");

// Keeps the app shell for offline launch (pwa/serviceWorker.ts). Development
// has none, and browsers offer none outside a secure context: HTTPS, or localhost.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // The app works without it; it only cannot open offline.
      // @effect-diagnostics-next-line globalConsole:off
      console.warn("The service worker did not register.", error);
    });
  });
}

// A build replaced while this page was open has deleted the scripts it would load
// next; loading the page again picks up the new build.
window.addEventListener("vite:preloadError", () => window.location.reload());

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
