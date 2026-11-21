// SPDX-License-Identifier: AGPL-3.0-or-later
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";
import { bundleInputs } from "../../scripts/bundle-inputs.ts";
import { pwa } from "./pwa/plugin.ts";

// The same plugin set as T3 Code's web client: file routes with per-route code
// splitting, the React Compiler (through oxc), and Tailwind CSS v4.
export default defineConfig(({ mode }) => {
  // In development, VITE_J3_SERVER names a server to run against (src/env.d.ts).
  const server = loadEnv(mode, import.meta.dirname, "VITE_").VITE_J3_SERVER;
  return {
    plugins: [
      tanstackRouter({
        autoCodeSplitting: true,
        // The router's own header, after the license identifier every source file carries.
        routeTreeFileHeader: [
          "// SPDX-License-Identifier: AGPL-3.0-or-later",
          "/* eslint-disable */",
          "// @ts-nocheck",
          "// noinspection JSUnusedGlobalSymbols",
        ],
      }),
      react({ compiler: true }),
      tailwindcss(),
      pwa(),
      // What the release's third-party notices are made from (scripts/build-release.ts).
      bundleInputs("web"),
    ],
    server: {
      port: 5833,
      strictPort: true,
      // The page's origin is the server's, as when the server serves the build.
      ...(server === undefined
        ? {}
        : {
            proxy: {
              "/api": server,
              "/attachments": server,
              "/ws": { target: server, ws: true },
            },
          }),
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  };
});
