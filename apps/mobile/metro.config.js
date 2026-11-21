// SPDX-License-Identifier: AGPL-3.0-or-later
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

// Expo finds the workspace root and its packages by itself. Uniwind compiles
// global.css, whose theme is generated from @j3-bots/design-tokens.
module.exports = withUniwindConfig(getDefaultConfig(__dirname), {
  cssEntryFile: "./global.css",
});
