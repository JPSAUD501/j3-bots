// SPDX-License-Identifier: AGPL-3.0-or-later
const { withAppBuildGradle } = require("expo/config-plugins");

// The generated project signs a release build with the debug key. A release
// build is signed after it is built instead, with `apksigner`, by whoever
// holds the release key: the release workflow's sign job, which runs nothing
// from the repository, or a maintainer (docs/operations/releasing.md). Without
// a signing config, Gradle writes app-release-unsigned.apk, which no phone
// installs, so no build signed with a key that is not the release's can be
// taken for one.
const LINE = "android.buildTypes.release.signingConfig = null";

module.exports = (config) =>
  withAppBuildGradle(config, (next) => {
    if (next.modResults.language !== "groovy")
      throw new Error(
        "app/build.gradle is not Groovy, so the release build cannot be left unsigned.",
      );
    if (!next.modResults.contents.includes(LINE))
      next.modResults.contents += `\n// plugins/unsignedRelease.js: release builds are signed after the build.\n${LINE}\n`;
    return next;
  });
