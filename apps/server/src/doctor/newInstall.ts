// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type Harness, HARNESSES } from "../engine/harnesses.ts";
import { Host } from "../system/Host.ts";
import { Systemd } from "../system/Systemd.ts";
import { type Check, check } from "./check.ts";

// The checks a machine that never ran J3 Bots needs most: whether it can run
// the service at all, whether the account is one a bot should run as, where to
// get a missing harness, how bots reach a model, and whether the engine can be
// downloaded. Like every check, they read and change nothing; the one request
// they make is the `HEAD` that asks GitHub whether the engine's download
// answers, and only while no server answers on the admin socket.

/** How the engine starts each harness on Linux, and what that needs (docs/architecture/engine.md#isolation). */
const HARNESS_SCOPES =
  "On Linux the engine starts each harness with `systemd-run --user --scope`, which needs this manager; whether bots run without it has not been checked.";

/**
 * Whether this user's systemd manager answers, on Linux. Without it the
 * service cannot be installed, run or managed: a problem with the service
 * installed, and a warning for `j3-bots serve` in a terminal, which starts
 * without it.
 */
export const userManagerCheck = Effect.fn("doctor.userManager")(function* (
  serviceInstalled: boolean,
) {
  const systemd = yield* Systemd;
  if (yield* systemd.available) {
    return check("User manager", "ok", "This user's systemd manager answers.");
  }
  const status = serviceInstalled ? "problem" : "warning";
  const host = yield* Host;
  if (!(yield* systemd.booted)) {
    return check(
      "User manager",
      status,
      `systemd did not start this machine, as in most containers and on WSL without systemd, so this user has no systemd manager, ${serviceInstalled ? "and the installed service cannot run." : `and the service cannot be installed. \`j3-bots serve\` starts without it. ${HARNESS_SCOPES}`}`,
      "On WSL, add `systemd=true` under `[boot]` in /etc/wsl.conf, run `wsl --shutdown` in Windows, and open the distribution again. In a container, run J3 Bots on the host or in a virtual machine instead.",
    );
  }
  return check(
    "User manager",
    status,
    `systemd runs this machine, but this user's manager does not answer from this shell, as in one opened with \`su\` or \`sudo -u\`, ${serviceInstalled ? "so the installed service cannot be checked or managed from here." : `so the service cannot be installed from here. \`j3-bots serve\` starts without it. ${HARNESS_SCOPES}`}`,
    `Log in as ${host.userName} directly, over SSH or on the console. From a \`sudo -iu\` shell, run \`export XDG_RUNTIME_DIR="/run/user/$(id -u)"\`; if it still does not answer, have an administrator run \`sudo loginctl enable-linger ${host.userName}\`, which starts the manager without a login.`,
  );
});

/**
 * Groups whose members can become root: through sudo (`sudo`, `wheel`,
 * `admin`), or by starting a container that mounts the host's root
 * (`docker`, `lxd`, `incus`).
 */
const ADMIN_GROUPS: ReadonlyArray<string> = ["sudo", "wheel", "admin", "docker", "lxd", "incus"];

/** The steps that give J3 Bots an account of its own, as `doctor` and the operator guide give them. */
const DEDICATED_USER =
  'Run J3 Bots as a user of its own, with no SSH keys and in no group that can become root: `sudo useradd --create-home --shell /bin/bash j3bots`, then `sudo loginctl enable-linger j3bots`, `sudo -iu j3bots` and `export XDG_RUNTIME_DIR="/run/user/$(id -u)"`. As that user, install J3 Bots and the harnesses, and give them their own sign-ins.';

/**
 * Whether the user the server runs as holds what a misled bot could use to
 * reach past this machine or take it over: SSH private keys, or membership of
 * a group that can become root (docs/architecture/security.md#running-on-a-machine-that-matters).
 */
export const runningUserCheck = Effect.gen(function* () {
  const host = yield* Host;
  const keys = yield* host.sshPrivateKeys;
  const admin = (yield* host.groups).filter((group) => ADMIN_GROUPS.includes(group));
  if (keys.length === 0 && admin.length === 0) {
    return check(
      "This user",
      "ok",
      `${host.userName} keeps no SSH private key directly in ~/.ssh and is in no group that can become root.`,
    );
  }
  const holds = [
    ...(keys.length === 0
      ? []
      : [
          `keeps ${keys.length === 1 ? "an SSH private key" : "SSH private keys"} (${keys.join(", ")})`,
        ]),
    ...(admin.length === 0
      ? []
      : [
          `is in ${admin.join(" and ")}, ${admin.length === 1 ? "a group that can" : "groups that can"} become root`,
        ]),
  ];
  return check(
    "This user",
    "warning",
    `${host.userName} ${holds.join(" and ")}. A bot in full access can do anything its user can, so one misled by what it reads could use that to reach other machines or take over this one.`,
    DEDICATED_USER,
  );
});

/**
 * A harness that is not on the `PATH` the report describes: on this shell's
 * only, which the service gets when it is installed again, or nowhere, with
 * where its maker says how to install it.
 */
export const missingHarnessCheck = Effect.fn("doctor.missingHarness")(function* (
  harness: Harness,
  servicePath: Option.Option<string>,
) {
  const host = yield* Host;
  const { name, executable, installPage } = HARNESSES[harness];
  if (Option.isSome(servicePath)) {
    const inShell = yield* host.findExecutable(executable, host.searchPath);
    if (Option.isSome(inShell)) {
      return check(
        name,
        "warning",
        `\`${executable}\` is at ${inShell.value}, which is not on the service's PATH, so bots cannot run on ${name}.`,
        "Run `j3-bots service install` again from this shell, so the service gets its PATH.",
      );
    }
  }
  return check(
    name,
    "warning",
    `\`${executable}\` is not on ${Option.isSome(servicePath) ? "the service's PATH or this shell's" : "PATH"}, so bots cannot run on ${name}.`,
    `Install ${name} as this user: ${installPage}. Then ${Option.isSome(servicePath) ? "run `j3-bots service install` again, so the service gets a PATH that has it" : "run this again from a shell whose PATH has it"}.`,
  );
});

/**
 * A harness the engine reports signed out has neither a provider connection
 * nor a sign-in in its J3-owned home: the two ways to reach its models.
 */
export const noWayToModels = (harness: Harness, connectCommand: string): Check => {
  const { name } = HARNESSES[harness];
  return check(
    name,
    "problem",
    `${name} has no way to reach its models yet: no provider connection is stored, and it is not signed in inside its J3 Bots home.`,
    `Either connect an endpoint that serves its models, such as a proxy in front of your subscriptions, with \`${connectCommand}\`, which restarts the engine; or sign ${name} in with its own account with \`j3-bots provider login ${harness}\`.`,
  );
};

/**
 * The pinned engine is not installed and no server described here runs: the
 * server downloads it on its first start. With `probe`, when no server answers
 * at all, whether that download answers; otherwise the report does not ask,
 * since a server it does not describe holds the home.
 */
export const engineDownloadCheck = Effect.fn("doctor.engineDownload")(function* (
  missing: { readonly version: string; readonly source: string },
  probe: boolean,
) {
  const download = `T3 Code ${missing.version} is not installed yet. The server downloads it from GitHub, about 200 MB, on its first start`;
  if (!probe) {
    return check(
      "Engine",
      "warning",
      `${download}.`,
      "Make sure this machine can reach github.com when the server first starts, or download it now with `j3-bots engine fetch`.",
    );
  }
  const host = yield* Host;
  if (yield* host.reachable(missing.source)) {
    return check("Engine", "ok", `${download}, and the download answers.`);
  }
  return check(
    "Engine",
    "problem",
    `T3 Code ${missing.version} is not installed yet, and its download on GitHub does not answer from this machine, so the server cannot start the engine.`,
    `Make sure this machine can reach github.com over HTTPS; \`curl -sSIL ${missing.source}\` shows where it fails. Once it answers, \`j3-bots engine fetch\` downloads it now, or the server does on its first start.`,
  );
});
