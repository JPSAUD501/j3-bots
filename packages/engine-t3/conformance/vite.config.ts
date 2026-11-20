// SPDX-License-Identifier: AGPL-3.0-or-later
import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";
import root from "../../../vite.config.ts";

// The conformance scenarios against the real engine. Kept out of the root
// `test`: they download and run the pinned engine, which takes minutes.
export default mergeConfig(
  root,
  defineConfig({
    test: {
      include: ["**/*.conformance.ts"],
      // One engine at a time.
      fileParallelism: false,
      // A real turn takes seconds, more on a loaded machine.
      testTimeout: 60_000,
    },
  }),
);
