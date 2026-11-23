// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateInability } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Installation from "../installation.ts";
import { installFolder } from "../install/layout.ts";
import * as Unit from "../service/unit.ts";
import { Host } from "../system/Host.ts";
import { ENABLE_LINGER, Systemd } from "../system/Systemd.ts";

// Whether this server can update itself when a client asks, and when it
// cannot, why, with what the operator runs instead. Only a server installed
// with install.sh and run by its systemd user service can: the update stops
// that service, so it runs in a transient unit of the same user manager
// (`launch.ts`), which needs `systemd-run` and a manager that outlives the
// operator's sessions (lingering). The desktop app's own server is updated
// by updating the app, which brings its server with it.

/** Why a server cannot update itself, and the command to run on its machine instead, if one. */
export interface CannotUpdate {
  readonly reason: UpdateInability;
  readonly command: string | null;
}

/** How this server updates itself when a client asks: `launch.ts`'s plan, less the run. */
export type UpdateHost =
  | {
      readonly _tag: "service";
      /** The running release's `j3-bots`. */
      readonly command: string;
      readonly home: string;
      readonly searchPath: string;
    }
  | ({ readonly _tag: "cannot" } & CannotUpdate);

/** The command an operator updates a service with on its machine. */
const BY_HAND = "j3-bots update";

/** How J3 Bots is installed so that it can update itself (`docs/operations/install.md`). */
const INSTALL =
  "curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/latest/download/install.sh | sh";

/**
 * How the server of `home`, started as `started` says, updates itself.
 * `started` is `desktop` when the desktop app runs it (with `--admin-fd`).
 */
export const updateHost = Effect.fn("update.updateHost")(function* (options: {
  readonly home: string;
  readonly started: "desktop" | "cli";
}) {
  const cannot = (reason: UpdateInability, command: string | null): UpdateHost => ({
    _tag: "cannot",
    reason,
    command,
  });
  if (options.started === "desktop") return cannot("desktop-managed", null);
  const installation = yield* Installation.installation;
  const { layout } = installation;
  if (layout._tag === "checkout") {
    return cannot(
      "checkout",
      "git pull && pnpm install --frozen-lockfile && pnpm build && j3-bots service install",
    );
  }
  if (Option.isNone(yield* installFolder(installation))) {
    return cannot("unpacked", INSTALL);
  }
  const systemd = yield* Systemd;
  const unit = yield* systemd.unitState(Unit.UNIT_NAME);
  if (!Option.contains(unit.mainPid, process.pid)) {
    return cannot("started-by-hand", BY_HAND);
  }
  const host = yield* Host;
  const path = yield* Path.Path;
  const command = path.join(layout.root, "bin", "j3-bots");
  if (Option.isNone(yield* host.findExecutable("systemd-run", host.searchPath))) {
    return cannot("no-systemd", BY_HAND);
  }
  const linger = yield* systemd.linger;
  if (linger !== "yes") return cannot("no-linger", ENABLE_LINGER);
  return {
    _tag: "service",
    command,
    home: options.home,
    searchPath: host.searchPath,
  } satisfies UpdateHost;
});
