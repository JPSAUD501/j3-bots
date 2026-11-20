// SPDX-License-Identifier: AGPL-3.0-or-later
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// The same plugin set as T3 Code's web client: file routes with per-route code
// splitting, the React Compiler (through oxc), and Tailwind CSS v4.
export default defineConfig({
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
  ],
  server: { port: 5833, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
