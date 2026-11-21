// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

// J3 Bots often runs on a LAN address over plain HTTP. A network security
// config names hosts, never address ranges, so it cannot say "private
// addresses only": it permits plain HTTP, and the app refuses it for any
// address outside loopback and the private ranges before it connects
// (parseServerAddress in @j3-bots/client-runtime).
const CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

const withManifestEntry = (config) =>
  withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (application === undefined)
      throw new Error("AndroidManifest.xml has no application element.");
    application.$ = {
      ...application.$,
      "android:networkSecurityConfig": "@xml/network_security_config",
    };
    return next;
  });

const withConfigFile = (config) =>
  withDangerousMod(config, [
    "android",
    (next) => {
      const directory = path.join(next.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "network_security_config.xml"), CONFIG);
      return next;
    },
  ]);

module.exports = (config) => withConfigFile(withManifestEntry(config));
