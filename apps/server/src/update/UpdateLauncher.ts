// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ServerConfig } from "../config.ts";
import type { Host } from "../system/Host.ts";
import { Systemd } from "../system/Systemd.ts";
import { type UpdateHost, updateHost } from "./host.ts";
import { launch, type LaunchFailed, updateUnit, type UpdateUnitPlan } from "./launch.ts";

/** A unit that has ended, as `systemctl is-active` says: a collected one is `inactive`. */
const ENDED: ReadonlySet<string> = new Set(["inactive", "failed"]);

/** What this server's machine gives an update: whether it can run one, and its unit. */
export class UpdateLauncher extends Context.Service<
  UpdateLauncher,
  {
    /** How this server updates itself, read again each time: an operator may turn lingering on. */
    readonly host: Effect.Effect<UpdateHost>;
    /** Starts the update `plan` names in its transient unit, and returns once it runs. */
    readonly launch: (plan: UpdateUnitPlan) => Effect.Effect<void, LaunchFailed>;
    /** Whether the unit of run `id` has ended, failed or not: one collected after it ended has. */
    readonly ended: (id: string) => Effect.Effect<boolean>;
  }
>()("@j3-bots/server/update/UpdateLauncher") {}

/**
 * The launcher of the server of `ServerConfig.home`, started as `started`
 * says: `desktop` when the desktop app runs it, which updates it with itself.
 */
export const layer = (started: "desktop" | "cli") =>
  Layer.effect(
    UpdateLauncher,
    Effect.gen(function* () {
      const { home } = yield* ServerConfig;
      const systemd = yield* Systemd;
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Host | Systemd
      >();
      return UpdateLauncher.of({
        host: updateHost({ home, started }).pipe(Effect.provideContext(context)),
        launch: (plan) => launch(plan).pipe(Effect.provideContext(context)),
        ended: (id) =>
          systemd.unitState(updateUnit(id)).pipe(Effect.map(({ active }) => ENDED.has(active))),
      });
    }),
  );
