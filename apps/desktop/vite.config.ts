// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite-plus";

// The main process and the preload script (`vp pack`, tsdown), as T3 Code
// builds its own: every dependency bundled in, Electron left to the runtime.
// The input hook screen recordings read keys and clicks through
// (`uiohook-napi`, decision 0098) is a native module: its prebuilt binary
// for each desktop target is copied beside the bundle, under
// `dist/native/uiohook/uiohook-napi/prebuilds/<platform>-<arch>/`, and loaded
// from there (src/recording/input.ts), with its licenses and notice
// (notices/uiohook); electron-builder.yml keeps them out of the asar.
// Playwright (`playwright-core`), which drives the app's own browser
// (decision 0110), reads its own files by path as it runs: it stays out of
// the bundle, and the parts of its package it runs, with its license and
// notices, are copied to `dist/node_modules/playwright-core`, where the
// bundle's import finds it.
// The notices of the T3 Code the bundle carries, adapted under MIT: the
// desktop's own browser's (NOTICE) and the driver's (packages/browser), in
// `dist/notices`.
// The bots' pointers the browser draws in its pages (decision 0110), which the
// web client's build bundles with the client's own pointer: `dist/presence.js`.
// The preload script is CommonJS, the only form a sandboxed preload can be.
// Tests use the root configuration.

/** What the main process loads from outside the bundle, beside Electron. */
const OUTSIDE = new Set(["electron", "playwright-core"]);

const shared = () => ({
  platform: "node" as const,
  sourcemap: true,
  // An application, not a library: nothing imports its types.
  dts: false,
  deps: {
    alwaysBundle: (id: string) => !OUTSIDE.has(id) && !id.startsWith("node:"),
    neverBundle: [...OUTSIDE],
    onlyBundle: false as const,
  },
});

export default defineConfig({
  pack: [
    {
      ...shared(),
      entry: { main: "src/main.ts" },
      format: "esm",
      outDir: "dist",
      clean: true,
      copy: [
        {
          from: "node_modules/uiohook-napi/prebuilds/*/uiohook-napi.node",
          to: "dist/native/uiohook",
          flatten: false,
        },
        { from: "node_modules/uiohook-napi/LICENSE", to: "dist/native/uiohook", flatten: false },
        { from: "notices/uiohook/*", to: "dist/native/uiohook" },
        { from: "NOTICE", to: "dist/notices/desktop-browser" },
        { from: "../web/dist-presence/presence.js", to: "dist" },
        { from: "../../packages/browser/NOTICE", to: "dist/notices/browser" },
        ...[
          "package.json",
          "index.js",
          "index.mjs",
          "browsers.json",
          "LICENSE",
          "NOTICE",
          "ThirdPartyNotices.txt",
          "lib/**",
        ].map((file) => ({
          from: `node_modules/playwright-core/${file}`,
          to: "dist/node_modules",
          flatten: false,
        })),
      ],
    },
    {
      ...shared(),
      entry: { preload: "src/preload.ts" },
      format: "cjs",
      outDir: "dist",
      clean: false,
      outExtensions: () => ({ js: ".cjs" }),
    },
  ],
});
