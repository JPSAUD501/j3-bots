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
// The preload script is CommonJS, the only form a sandboxed preload can be.
// Tests use the root configuration.

const shared = () => ({
  platform: "node" as const,
  sourcemap: true,
  // An application, not a library: nothing imports its types.
  dts: false,
  deps: {
    alwaysBundle: (id: string) => id !== "electron" && !id.startsWith("node:"),
    neverBundle: ["electron"],
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
