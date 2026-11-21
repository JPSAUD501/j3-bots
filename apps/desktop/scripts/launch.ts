// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A development launcher that starts Electron, run by Node with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

// Starts the development build (`pnpm dev`) with the arguments given.

const electron: unknown = NodeModule.createRequire(import.meta.url)("electron");
if (typeof electron !== "string") throw new Error("The electron package gave no executable path.");

/**
 * Whether Chromium's setuid sandbox helper is installed: root-owned with mode
 * 4755. A package manager's copy never is, and where the system also refuses
 * unprivileged user namespaces (Ubuntu's AppArmor default), Electron will not
 * start sandboxed. Development then runs with `--no-sandbox`, as T3 Code's
 * launcher does; a packaged build installs the helper.
 */
const sandboxInstalled = (): boolean => {
  if (process.platform !== "linux") return true;
  try {
    const helper = NodeFS.statSync(NodePath.join(NodePath.dirname(electron), "chrome-sandbox"));
    return helper.uid === 0 && (helper.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
};

const sandboxArgs = sandboxInstalled() ? [] : ["--no-sandbox"];
if (sandboxArgs.length > 0) {
  console.warn("Chromium's sandbox helper is not installed; starting Electron with --no-sandbox.");
}
const child = NodeChildProcess.spawn(
  electron,
  [NodePath.join(import.meta.dirname, ".."), ...sandboxArgs, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
