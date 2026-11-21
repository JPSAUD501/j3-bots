// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite-plus";

// The main process and the preload script (`vp pack`, tsdown), as T3 Code
// builds its own: every dependency bundled in, Electron left to the runtime.
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
    { ...shared(), entry: { main: "src/main.ts" }, format: "esm", outDir: "dist", clean: true },
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
