// SPDX-License-Identifier: AGPL-3.0-or-later
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

// Folding or unfolding a foldable moves the app to a display of another size
// and density. Unless the activity handles each of these changes itself,
// Android destroys it and builds it again, and every screen loses what it
// held, a form's edits and a save under way among them. Handled here, the
// activity stays and React Native lays out again at the new size.
const HANDLED = ["density", "orientation", "screenLayout", "screenSize", "smallestScreenSize"];

module.exports = (config) =>
  withAndroidManifest(config, (next) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(next.modResults);
    const present = (activity.$["android:configChanges"] ?? "").split("|").filter(Boolean);
    const missing = HANDLED.filter((change) => !present.includes(change));
    activity.$["android:configChanges"] = [...present, ...missing].join("|");
    return next;
  });
