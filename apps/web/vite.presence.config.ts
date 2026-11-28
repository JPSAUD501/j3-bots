// SPDX-License-Identifier: AGPL-3.0-or-later
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";

/** The root size the client's stylesheet is written for: a page's own root size says nothing of the pointer's. */
const ROOT_PIXELS = 16;

/**
 * The drawing's stylesheet in pixels. A shadow root's `rem` is the page's
 * root size, which a site sets as it likes (often to 10px): the pointer's
 * tag keeps the client's size on any page.
 */
const pixels = (): Plugin => ({
  name: "j3-presence-pixels",
  enforce: "post",
  transform: (code, id) =>
    id.endsWith(".css?inline")
      ? code.replaceAll(
          /(?<![\w.-])(\d*\.?\d+)rem\b/g,
          (_, size: string) => `${Number(size) * ROOT_PIXELS}px`,
        )
      : null,
});

// The bots' pointers the desktop's browser draws in a page (src/browser/desktop/presence):
// one script, with its stylesheet inside, that the desktop app carries and runs in a world
// of its own in the page. Apart from the client's build, which the server serves.
export default defineConfig({
  plugins: [react({ compiler: true }), tailwindcss(), pixels()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  // The client's own files (public/) are the server's to serve, not the page's.
  publicDir: false,
  build: {
    outDir: "dist-presence",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: "src/browser/desktop/presence/overlay.tsx",
      formats: ["iife"],
      name: "j3PresenceDrawing",
      fileName: () => "presence.js",
    },
  },
});
