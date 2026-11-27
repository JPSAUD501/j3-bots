// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the printed command is run by a real shell, as the administrator's would run it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  apparmorProfile,
  browserPlatformOf,
  inspectBrowserHost,
  missingLibrariesOf,
  setupOf,
} from "./BrowserHost.ts";

describe("the browser's host setup", () => {
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
    assert.strictEqual(sink, "sudo tee /etc/apparmor.d/t3-chrome-headless-shell > /dev/null");
    const written = NodeChildProcess.execFileSync("sh", ["-c", produce], { encoding: "utf8" });
    assert.strictEqual(written, apparmorProfile.map((profileLine) => `${profileLine}\n`).join(""));
    assert.strictEqual(load, "sudo apparmor_parser -r /etc/apparmor.d/t3-chrome-headless-shell");
  });

  it("loads a profile on disk the system has not loaded, and has no command for a cause it does not know", () => {
    const needs = {
      missingLibraries: [],
      noFonts: false,
      packageManager: { _tag: "none" },
    } as const;
    assert.deepStrictEqual(setupOf({ ...needs, sandbox: "profile-unloaded" }), {
      setup: ["sudo apparmor_parser -r /etc/apparmor.d/t3-chrome-headless-shell"],
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

  const platform = browserPlatformOf(process.arch);
  it.effect.skipIf(process.platform === "win32" || platform === undefined)(
    "checks the browser the engine runs, not one it kept from before, for another processor, or another left there",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const other = platform === "linux64" ? "linux-arm64" : "linux64";
        const browser = (version: string, script: string, built = platform ?? "") =>
          Effect.gen(function* () {
            const folder = path.join(home, "tools", "chrome-headless-shell", built, version);
            yield* fs.makeDirectory(folder, { recursive: true });
            const executable = path.join(folder, "chrome-headless-shell");
            yield* fs.writeFileString(executable, `#!/bin/sh\n${script}\n`);
            yield* fs.chmod(executable, 0o755);
          });
        const broken =
          "echo 'chrome-headless-shell: error while loading shared libraries: libold.so.1: cannot open shared object file' >&2; exit 127";
        // Only the one the engine kept from before, and its own built for another
        // processor: the engine downloads the one it runs on first use.
        yield* browser("157.0.8075.62", broken);
        yield* browser("158.0.8127.88", broken, other);
        const before = yield* inspectBrowserHost({ home, sandboxRefused: false });
        assert.isFalse(before.downloaded);
        assert.deepStrictEqual(before.missingLibraries, []);

        // Once it has, that one is checked, whatever else is there.
        yield* browser("158.0.8127.88", "echo 'Google Chrome for Testing 158.0.8127.88'");
        yield* browser("159.0.8200.10", broken);
        const needs = yield* inspectBrowserHost({ home, sandboxRefused: false });
        assert.isTrue(needs.downloaded);
        assert.deepStrictEqual(needs.missingLibraries, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
