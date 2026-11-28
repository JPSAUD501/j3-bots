// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the printed command is run by a real shell, as the administrator's would run it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { chromeFolders, chromePlatformOf } from "./chrome.ts";
import {
  apparmorProfile,
  type HostProbes,
  inspectBrowserHost,
  missingLibrariesOf,
  offeredPackagesOf,
  setupOf,
  type SystemTool,
} from "./hostNeeds.ts";

describe("the server browser's host setup", () => {
  it("writes, through sudo tee, exactly the profile it shows", () => {
    const { setup } = setupOf({
      sandbox: "no-profile",
      missingLibraries: [],
      noFonts: false,
      packageManager: { _tag: "none" },
    });
    const [write, load] = setup;
    assert.isDefined(write);
    const [produce, sink] = write.split(" | ");
    assert.isDefined(produce);
    assert.strictEqual(sink, "sudo tee /etc/apparmor.d/j3-bots-chrome > /dev/null");
    const written = NodeChildProcess.execFileSync("sh", ["-c", produce], { encoding: "utf8" });
    assert.strictEqual(written, apparmorProfile.map((profileLine) => `${profileLine}\n`).join(""));
    assert.strictEqual(load, "sudo apparmor_parser -r /etc/apparmor.d/j3-bots-chrome");
  });

  it("loads a profile on disk the system has not loaded, and has no command for a cause it does not know", () => {
    const needs = {
      missingLibraries: [],
      noFonts: false,
      packageManager: { _tag: "none" },
    } as const;
    assert.deepStrictEqual(setupOf({ ...needs, sandbox: "profile-unloaded" }), {
      setup: ["sudo apparmor_parser -r /etc/apparmor.d/j3-bots-chrome"],
      packagesByHand: false,
    });
    assert.deepStrictEqual(setupOf({ ...needs, sandbox: "unknown" }), {
      setup: [],
      packagesByHand: false,
    });
  });

  it("installs the libraries and fonts with the host's package manager, or leaves them to the administrator", () => {
    const needs = { sandbox: "none" as const, missingLibraries: ["libnss3.so"], noFonts: true };
    assert.deepStrictEqual(
      setupOf({ ...needs, packageManager: { _tag: "apt-get", libraries: ["libnss3", "libgbm1"] } }),
      {
        setup: [
          "sudo apt-get update",
          "sudo apt-get install -y --no-install-recommends libnss3 libgbm1 fontconfig fonts-liberation",
        ],
        packagesByHand: false,
      },
    );
    assert.deepStrictEqual(setupOf({ ...needs, packageManager: { _tag: "dnf" } }), {
      setup: ["sudo dnf install -y 'libnss3.so()(64bit)' fontconfig liberation-sans-fonts"],
      packagesByHand: false,
    });
    assert.deepStrictEqual(setupOf({ ...needs, packageManager: { _tag: "none" } }), {
      setup: [],
      packagesByHand: true,
    });
  });

  it("names only libraries that look like one: the browser is a file the service account can replace", () => {
    const ldd = [
      "\tlinux-vdso.so.1 (0x00007ffd)",
      "\tlibnss3.so => not found",
      "\t$(touch${IFS}/tmp/owned).so => not found",
      "\tlibgbm.so.1 => not found",
      "\tlib'x.so => not found",
    ].join("\n");
    assert.deepStrictEqual(missingLibrariesOf("libnss3.so", ldd), ["libnss3.so", "libgbm.so.1"]);
    assert.deepStrictEqual(missingLibrariesOf("$(reboot).so", ""), []);
  });

  it("reads which of several packages apt offers from one apt-cache run", () => {
    const policy = [
      "libasound2t64:",
      "  Installed: (none)",
      "  Candidate: 1.2.11-1build2",
      "  Version table:",
      "     1.2.11-1build2 500",
      "        500 http://archive.example/ubuntu noble/main amd64 Packages",
      "libasound2:",
      "  Installed: (none)",
      "  Candidate: (none)",
      "  Version table:",
      "libnss3:",
      "  Installed: 2:3.98-1build1",
      "  Candidate: 2:3.98-1build1",
      "  Version table:",
      " *** 2:3.98-1build1 500",
      "        100 /var/lib/dpkg/status",
    ].join("\n");
    assert.deepStrictEqual([...offeredPackagesOf(policy)], ["libasound2t64", "libnss3"]);
  });

  /**
   * A Debian host, as the probes report it: apt offers the `t64` names, no
   * sandbox restriction, a font, and `ldd` listing the library the loader
   * misses. Each tool run is recorded.
   */
  const debianHost = () => {
    const runs: Array<{ readonly tool: SystemTool; readonly args: ReadonlyArray<string> }> = [];
    const probes: HostProbes = {
      tool: (tool, args) =>
        Effect.sync(() => {
          runs.push({ tool, args });
          switch (tool) {
            case "ldd":
              return "\tlinux-vdso.so.1 (0x00007ffd)\n\tlibgbm.so.1 => not found";
            case "fc-match":
              return "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";
            case "apt-cache":
              return [
                "libasound2t64:",
                "  Installed: (none)",
                "  Candidate: 1.2.11-1build2",
                "libasound2:",
                "  Installed: (none)",
                "  Candidate: (none)",
              ].join("\n");
          }
        }),
      exists: (file) => Effect.succeed(file === "/usr/bin/apt-get"),
      read: () => Effect.succeed("0"),
    };
    return { probes, runs: () => runs };
  };

  const platform = Option.getOrUndefined(chromePlatformOf(process.platform, process.arch));
  // The browser it runs is a script, as the loader would answer for Chrome.
  it.effect.skipIf(process.platform !== "linux" || platform === undefined)(
    "checks the libraries of the browser the server downloaded, once it has, and the packages apt offers for them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        if (platform === undefined) return;
        const { executable } = chromeFolders(path, home, platform);
        const browser = (script: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
            yield* fs.writeFileString(executable, `#!/bin/sh\n${script}\n`);
            yield* fs.chmod(executable, 0o755);
          });
        const host = debianHost();
        const inspect = inspectBrowserHost({ home, sandboxRefused: false, probes: host.probes });
        const aptRuns = () => host.runs().filter((run) => run.tool === "apt-cache");

        const before = yield* inspect;
        assert.isFalse(before.downloaded);
        assert.deepStrictEqual(before.missingLibraries, []);
        assert.deepStrictEqual(aptRuns(), []);

        yield* browser(
          "echo 'chrome: error while loading shared libraries: libgbm.so.1: cannot open shared object file' >&2; exit 127",
        );
        const broken = yield* inspect;
        assert.isTrue(broken.downloaded);
        assert.deepStrictEqual(broken.missingLibraries, ["libgbm.so.1"]);
        // One apt-cache run asks for every name.
        const [asked, ...more] = aptRuns();
        assert.deepStrictEqual(more, []);
        assert.includeMembers([...(asked?.args ?? [])], ["policy", "libasound2t64", "libasound2"]);
        const install = broken.setup.find((command) => command.includes(" install ")) ?? "";
        assert.include(install.split(" "), "libasound2t64");
        assert.notInclude(install.split(" "), "libasound2");

        yield* browser("echo 'Google Chrome for Testing 158.0.8127.88'");
        const working = yield* inspect;
        assert.deepStrictEqual(working.missingLibraries, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
