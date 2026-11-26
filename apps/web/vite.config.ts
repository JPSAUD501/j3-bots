// SPDX-License-Identifier: AGPL-3.0-or-later
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import {
  CONNECTOR_APP_FRAME_PATH,
  CONNECTOR_APP_FRAME_POLICY,
  VISUAL_FRAME_PATH,
  VISUAL_FRAME_POLICY,
} from "@j3-bots/contracts";
import { defineConfig, loadEnv, type Plugin } from "vite-plus";
import { bundleInputs } from "../../scripts/bundle-inputs.ts";
import { pwa } from "./pwa/plugin.ts";

/**
 * The development server frames a bot's visual and a connector's app as the
 * J3 Bots server does (apps/server/src/web/WebClient.ts): each one's page
 * under its own policy, and every other page allowed to frame only its own
 * origin. So a visual or an app that reaches past its policy fails here as it
 * would in production.
 */
const visualFrame = (): Plugin => ({
  name: "j3-visual-frame",
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      response.setHeader(
        "content-security-policy",
        path === VISUAL_FRAME_PATH
          ? VISUAL_FRAME_POLICY
          : path === CONNECTOR_APP_FRAME_PATH
            ? CONNECTOR_APP_FRAME_POLICY
            : "frame-src 'self'",
      );
      next();
    });
  },
});

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
      visualFrame(),
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
