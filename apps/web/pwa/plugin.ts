// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- build tooling that runs in Vite's Node process, outside any Effect program.
import { createHash } from "node:crypto";
import type { Plugin } from "vite-plus";
import { canvasColor, darkCanvasColor, iconPng, iconSvg } from "./icons.ts";
import { serviceWorkerSource } from "./serviceWorker.ts";

const NAME = "J3 Bots";
const SERVICE_WORKER = "sw.js";

/** Icons shown as they are fill more of the square than maskable ones, whose edge a launcher may crop. */
const SHOWN_WIDTH = 0.74;
const MASKABLE_WIDTH = 0.62;

interface GeneratedFile {
  readonly type: string;
  readonly body: () => string | Uint8Array;
}

const manifest = {
  id: "/",
  name: NAME,
  short_name: NAME,
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: canvasColor,
  theme_color: canvasColor,
  icons: [
    { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
    { src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
    { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
    { src: "/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
  ],
};

/** The files the plugin writes, by their path at the site's root. */
const files: Readonly<Record<string, GeneratedFile>> = {
  "manifest.webmanifest": {
    type: "application/manifest+json",
    body: () => `${JSON.stringify(manifest, null, 2)}\n`,
  },
  "icon.svg": { type: "image/svg+xml", body: iconSvg },
  "icon-192.png": { type: "image/png", body: () => iconPng(192, SHOWN_WIDTH) },
  "icon-512.png": { type: "image/png", body: () => iconPng(512, SHOWN_WIDTH) },
  "icon-maskable-512.png": { type: "image/png", body: () => iconPng(512, MASKABLE_WIDTH) },
  // iOS takes its home-screen icon from here, not the manifest, and rounds its corners itself.
  "apple-touch-icon.png": { type: "image/png", body: () => iconPng(180, SHOWN_WIDTH) },
};

/**
 * Makes the build an installable web app: a manifest, icons drawn from the
 * avatar shapes, and a service worker that keeps the app shell for offline
 * launch. Development serves the manifest and icons but no service worker,
 * which would keep stale modules between edits.
 */
export function pwa(): Plugin {
  return {
    name: "j3-bots:pwa",
    // After Vite has written index.html into the bundle, so the worker can keep it.
    enforce: "post",
    transformIndexHtml: () => [
      // With credentials, so an authenticating proxy in front of the server (a
      // single sign-on gate) lets the browser read the manifest: without them a
      // browser fetches it with no cookies, gets the sign-in page instead, and
      // never offers to install the app.
      {
        tag: "link",
        attrs: { rel: "manifest", href: "/manifest.webmanifest", crossorigin: "use-credentials" },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
        injectTo: "head",
      },
      {
        tag: "meta",
        attrs: { name: "apple-mobile-web-app-title", content: NAME },
        injectTo: "head",
      },
      {
        tag: "meta",
        attrs: {
          name: "theme-color",
          content: canvasColor,
          media: "(prefers-color-scheme: light)",
        },
        injectTo: "head",
      },
      {
        tag: "meta",
        attrs: {
          name: "theme-color",
          content: darkCanvasColor,
          media: "(prefers-color-scheme: dark)",
        },
        injectTo: "head",
      },
    ],
    configureServer: (server) => {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
        const file = files[path];
        if (file === undefined) return next();
        response.setHeader("content-type", file.type);
        response.end(file.body());
      });
    },
    generateBundle(_, bundle) {
      if (!("index.html" in bundle))
        throw new Error("The service worker needs index.html in the bundle.");
      // Everything the page loads: what Vite wrote, less the source maps, which
      // are for debugging only, and the files above.
      const kept = new Map<string, string | Uint8Array>();
      for (const output of Object.values(bundle)) {
        if (output.fileName.endsWith(".map")) continue;
        kept.set(output.fileName, output.type === "chunk" ? output.code : output.source);
      }
      for (const [fileName, file] of Object.entries(files)) {
        const source = file.body();
        this.emitFile({ type: "asset", fileName, source });
        kept.set(fileName, source);
      }
      const names = [...kept.keys()].sort();
      // Named by every kept file's content, so any change makes a new worker and a new cache.
      const hash = createHash("sha256");
      for (const name of names) hash.update(name).update(kept.get(name) ?? "");
      this.emitFile({
        type: "asset",
        fileName: SERVICE_WORKER,
        source: serviceWorkerSource(
          hash.digest("hex").slice(0, 16),
          names.map((name) => `/${name}`),
        ),
      });
    },
  };
}
