// SPDX-License-Identifier: AGPL-3.0-or-later
const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require("expo/config-plugins");
const { accent } = require("@j3-bots/design-tokens/icons/colors.json");

// What Android draws in the app's own color, such as a dialog's buttons and a
// text field's cursor and handles, takes the accent token of the theme the
// app is in, not the template's blue (`colorPrimary`) or AppCompat's teal
// (`colorAccent`). Expo writes `colorPrimary` from `primaryColor` for the
// light theme only; the dark one is written here.

/** `resources` with `colorPrimary` and `colorAccent` set to `value`. */
const withAccent = (resources, value) =>
  ["colorPrimary", "colorAccent"].reduce(
    (xml, name) => AndroidConfig.Colors.assignColorValue(xml, { name, value }),
    resources,
  );

module.exports = (config) => {
  const colored = withAndroidColorsNight(
    withAndroidColors(config, (next) => {
      next.modResults = withAccent(next.modResults, accent.light);
      return next;
    }),
    (next) => {
      next.modResults = withAccent(next.modResults, accent.dark);
      return next;
    },
  );
  return withAndroidStyles(colored, (next) => {
    next.modResults = AndroidConfig.Styles.assignStylesValue(next.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name: "colorAccent",
      value: "@color/colorAccent",
    });
    return next;
  });
};
