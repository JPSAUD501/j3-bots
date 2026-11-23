// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- a build hook electron-builder runs, outside any Effect program.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { type AfterPackContext, Arch } from "electron-builder";
import { checkServerRuntime, isPlatform, platformBuild } from "../../../scripts/release-layout.ts";

// electron-builder runs this for each package once its files are laid out,
// before it signs and packs them (electron-builder.yml, `afterPack`).
// electron-builder only warns when a folder `extraResources` names is
// missing, so this is what fails a build whose package would lack local mode:
// a package for a platform the server runtime is built for carries that
// runtime, of the app's own version; any other carries none.

export default function afterPack(context: AfterPackContext): void {
  const platform = `${context.electronPlatformName}-${Arch[context.arch]}`;
  const runtime = NodePath.join(
    context.packager.getResourcesDir(context.appOutDir),
    "server-runtime",
  );
  if (isPlatform(platform) && platformBuild(platform).serverRuntime) {
    const manifest = checkServerRuntime(runtime, {
      platform,
      version: context.packager.appInfo.version,
    });
    console.log(
      `  • server runtime  J3 Bots ${manifest.version} for ${platform}, Node.js ${manifest.node}`,
    );
    return;
  }
  if (NodeFS.existsSync(runtime)) {
    throw new Error(
      `The ${platform} package carries a server runtime, but local mode does not run there.`,
    );
  }
}
