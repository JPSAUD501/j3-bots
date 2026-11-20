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
    ignorePatterns: [...GENERATED_AND_VENDORED, "docs/**"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: GENERATED_AND_VENDORED,
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
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
  },
});
