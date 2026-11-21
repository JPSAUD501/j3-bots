// SPDX-License-Identifier: AGPL-3.0-or-later
// What the shared packages use and Hermes lacks (observed on Android with
// React Native 0.88): Intl.PluralRules for the catalog's plural sentences,
// Intl.ListFormat for lists of names, and Array.prototype.toSorted. Each one
// installs only where the engine has none, before any other module runs.
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/pt.js";
import "@formatjs/intl-listformat/polyfill.js";
import "@formatjs/intl-listformat/locale-data/en.js";
import "@formatjs/intl-listformat/locale-data/pt.js";
import "core-js/actual/array/to-sorted.js";
