// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReleaseVersion } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { channelOf } from "@j3-bots/release";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import packageJson from "../../package.json" with { type: "json" };
import { type FeedStatus, ReleaseFeed } from "../releases/ReleaseFeed.ts";
import type { UpdateHost } from "../update/host.ts";
import type { UpdateUnitPlan } from "../update/launch.ts";
import { UpdateLauncher } from "../update/UpdateLauncher.ts";
import * as UpdateRuns from "../update/UpdateRuns.ts";

/** What the feed says when it offers `available`, verified, on the stable channel, or nothing. */
export const feedStatus = (available: Option.Option<ReleaseVersion>): FeedStatus => ({
  current: {
    version: packageJson.version,
    channel: Option.getOrNull(channelOf(packageJson.version)),
  },
  channel: "stable",
  available: Option.match(available, {
    onNone: () => null,
    onSome: (version) => ({
      version,
      channel: "stable",
      publishedAt: DateTime.makeUnsafe("2026-11-20T12:00:00Z"),
      notesUrl: `https://example.com/releases/v${version}`,
      verified: true,
    }),
  }),
  waitingForStable: false,
  refused: null,
  lastCheck: null,
  checking: false,
});

/** A feed that answers what `status` says, and whose check finds nothing new. */
export const feedLayer = (status: Effect.Effect<FeedStatus>) =>
  Layer.succeed(
    ReleaseFeed,
    ReleaseFeed.of({ status, changes: Stream.fromEffect(status), check: status }),
  );

/** A machine where the server runs as `host` says, which records each update it starts in `launched`. */
export const launcherLayer = (host: UpdateHost, launched: Array<UpdateUnitPlan>) =>
  Layer.succeed(
    UpdateLauncher,
    UpdateLauncher.of({
      host: Effect.succeed(host),
      launch: (plan) =>
        Effect.sync(() => {
          launched.push(plan);
        }),
      ended: () => Effect.succeed(false),
    }),
  );

/**
 * Updates as a test that is not about them sees them: the feed offers
 * nothing, and the server was started by hand. Its runs need the domain's
 * configuration and running work.
 */
export const layer = Layer.merge(
  feedLayer(Effect.succeed(feedStatus(Option.none()))),
  UpdateRuns.layer.pipe(
    Layer.provide(
      launcherLayer({ _tag: "cannot", reason: "started-by-hand", command: "j3-bots update" }, []),
    ),
  ),
);
