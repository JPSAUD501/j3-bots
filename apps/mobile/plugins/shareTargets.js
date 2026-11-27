// SPDX-License-Identifier: AGPL-3.0-or-later
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

// Android reads an app's Direct Share targets from the shortcuts file its
// launcher activity names, and the share sheet's module brings that file
// (modules/share-sheet, res/xml/share_targets.xml) but cannot name it from
// the main activity itself.
const SHORTCUTS = "android.app.shortcuts";

module.exports = (config) =>
  withAndroidManifest(config, (next) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(next.modResults);
    const data = (activity["meta-data"] ?? []).filter(
      (entry) => entry.$["android:name"] !== SHORTCUTS,
    );
    activity["meta-data"] = [
      ...data,
      { $: { "android:name": SHORTCUTS, "android:resource": "@xml/share_targets" } },
    ];
    return next;
  });
