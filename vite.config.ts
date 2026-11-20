// SPDX-License-Identifier: AGPL-3.0-or-later
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Adapted from T3 Code's root config (MIT): the same test policy, formatter and
// lint rule set, without the rules for code J3 Bots does not have yet.

const GENERATED_AND_VENDORED = [
  "dist",
  "node_modules",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
  // Upstream source, byte for byte. scripts/vendor-t3-contracts.sh replaces it.
  "packages/engine-t3/vendor/**",
  // Written by the router plugin and the token generator.
  "**/routeTree.gen.ts",
  "packages/design-tokens/generated/**",
];

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/vendor/**"],
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
  },
  fmt: {
    // The templates' bytes are the prompt, and they set its version: no formatter rewraps them.
    ignorePatterns: [...GENERATED_AND_VENDORED, "docs/**", "packages/prompts/src/templates/**"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: GENERATED_AND_VENDORED,
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "eslint/no-control-regex": "off",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "eslint/no-unneeded-ternary": "error",
      // Only the engine adapter may know T3 Code exists (see the override below).
      "eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@t3tools/*"],
              message:
                "Only packages/engine-t3 may import T3 Code. Use the Engine interface or @j3-bots/contracts.",
            },
          ],
        },
      ],
      "eslint/no-unsafe-optional-chaining": "error",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "eslint/no-await-in-loop": "off",
      "eslint/no-shadow": "off",
      "eslint/no-underscore-dangle": "off",
      "oxc/no-accumulating-spread": "error",
      "oxc/no-map-spread": "off",
      "react/no-object-type-as-default-prop": "off",
      "react/jsx-no-constructed-context-values": "off",
      "react/memo-dependencies": "error",
      "react/purity": "error",
      "react/refs": "error",
      "react/exhaustive-effect-dependencies": "error",
      "react/set-state-in-effect": "error",
      "react/immutability": "error",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "react/static-components": "error",
      "react/capitalized-calls": "error",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "typescript/no-explicit-any": "error",
      "typescript/no-extraneous-class": "error",
      "typescript/no-this-alias": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-reverse": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-useless-fallback-in-spread": "error",
      "unicorn/no-useless-spread": "error",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/require-module-specifiers": "error",
    },
    overrides: [
      {
        files: ["packages/engine-t3/**"],
        rules: { "eslint/no-restricted-imports": "off" },
      },
    ],
  },
});
