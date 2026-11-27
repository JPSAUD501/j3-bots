// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A helper that prints a reading per line for as long as a recording runs, which only Node's own spawn gives as a stream.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { POWERSHELL, powerShellArgs, system32, withoutModulePath } from "@j3-bots/processes";
import * as Effect from "effect/Effect";

// Whether a password is being typed, read five times a second while a
// recording runs, so the keys typed into one are kept only as "typed a
// password" (events.ts). macOS says so for the whole system: an app that
// takes a password turns on secure event input (IsSecureEventInputEnabled,
// HIToolbox), asked through `osascript`. Windows says it of the control
// that has the keys: UI Automation's IsPassword, asked through Windows
// PowerShell. Linux has no such signal, so there the sheet asks the operator
// to pause before typing one.

const MAC = `
ObjC.import("Carbon");
ObjC.import("Foundation");
function run() {
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  for (;;) {
    const line = $.IsSecureEventInputEnabled() ? "1\\n" : "0\\n";
    out.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
    delay(0.2);
  }
}
`;

const WINDOWS = String.raw`
Add-Type -AssemblyName UIAutomationClient
while ($true) {
  $on = $false
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $focused) { $on = $focused.Current.IsPassword }
  } catch { $on = $false }
  [Console]::Out.WriteLine($(if ($on) { '1' } else { '0' }))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 200
}
`;

/** Whether this system says when a password is typed. */
export const passwordsHere = (platform: NodeJS.Platform): "hidden" | "pause" =>
  platform === "darwin" || platform === "win32" ? "hidden" : "pause";

/**
 * Hands each reading to `reading` and calls `lost` once if the helper stops
 * giving them, until the scope closes. Does nothing where the system gives
 * no signal.
 */
export const watchSecureInput = Effect.fn("recording.watchSecureInput")(function* (
  reading: (on: boolean) => void,
  lost: () => void,
) {
  const command =
    process.platform === "darwin"
      ? { program: "/usr/bin/osascript", args: ["-l", "JavaScript", "-e", MAC], env: process.env }
      : process.platform === "win32"
        ? {
            program: system32(process.env, POWERSHELL),
            args: [...powerShellArgs(WINDOWS)],
            env: withoutModulePath(process.env),
          }
        : null;
  if (command === null) return;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      let stopping = false;
      const child = NodeChildProcess.spawn(command.program, command.args, {
        env: command.env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const lines = NodeReadline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (line === "1" || line === "0") reading(line === "1");
      });
      const end = () => {
        if (!stopping) {
          stopping = true;
          lost();
        }
      };
      child.on("exit", end);
      child.on("error", end);
      return {
        stop: () => {
          stopping = true;
          lines.close();
          child.kill();
        },
      };
    }),
    (watcher) => Effect.sync(watcher.stop),
  );
});
