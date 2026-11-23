// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a test of a shell script.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// scripts/nightly-version.sh, which names the nightly workflow's build. How
// its versions order against releases is in androidVersionCode's test and the
// server's compareVersions test.

const SCRIPT = NodePath.join(import.meta.dirname, "nightly-version.sh");

const run = (...args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(SCRIPT, args, { encoding: "utf8" });

describe("nightly-version.sh", () => {
  it("names a pre-release of the next patch, for its day and run", () => {
    expect(run("0.3.0", "20261124", "57").stdout).toBe("0.3.1-nightly.20261124.57\n");
    expect(run("1.9.99", "20270101", "1").stdout).toBe("1.9.100-nightly.20270101.1\n");
  });

  it("names the patch after a release candidate's, so the nightly sorts above it", () => {
    expect(run("0.3.1-rc.1", "20261124", "58").stdout).toBe("0.3.2-nightly.20261124.58\n");
  });

  it("refuses anything but a release's version, a day and a run number", () => {
    for (const args of [
      ["0.3.0-beta.1", "20261124", "57"],
      ["0.3.0-rc.0", "20261124", "57"],
      ["0.3.0-nightly.20261123.1", "20261124", "57"],
      ["v0.3.0", "20261124", "57"],
      ["0.3", "20261124", "57"],
      ["0.03.0", "20261124", "57"],
      ["0.3.0", "2026-11-24", "57"],
      ["0.3.0", "20261124", "0"],
      ["0.3.0", "20261124", "057"],
      ["0.3.0", "20261124"],
    ]) {
      const result = run(...args);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.stdout, args.join(" ")).toBe("");
    }
  });
});
