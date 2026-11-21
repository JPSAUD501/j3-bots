// SPDX-License-Identifier: AGPL-3.0-or-later
import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";
import root from "../../../vite.config.ts";

// The behavior evals against real models (`docs/prompts/architecture.md#evaluation`).
// Kept out of the root `test`: they spend allowance and need an endpoint.
export default mergeConfig(
  root,
  defineConfig({
    test: {
      include: ["**/*.eval.ts"],
      // A turn is several model calls, each seconds long, more behind a busy proxy.
      testTimeout: 300_000,
      // One line per case, pass or fail, for the record a run leaves.
      reporters: ["verbose"],
    },
  }),
);
