// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import type { LaunchUpdate, UpdatePhase } from "@j3-bots/desktop-bridge";

// Updating the app, as a pure model: where it stands, and what each thing
// that happens does to it. The updater module feeds it electron-updater's
// events, the verdict on each download, the page's reports and the
// operator's requests, and acts only when a step says so. Four rules live
// here and nowhere else: the app installs a version by itself only where
// "Update automatically" is on, and then only as it starts, before the
// operator is at work, or as it quits, never mid-use; otherwise only once
// the operator asked; never while the page reports a save under way; and
// never a download that has not matched the release's signed checksums.

/**
 * How a build updates: it downloads and installs a newer version itself
 * (`install`), it only says one is out and where to get it (`notify`), or it
 * does neither (`off`).
 */
export type UpdateMode = "install" | "notify" | "off";

export interface Updates {
  readonly phase: UpdatePhase;
  /** The releases the app follows: stable ones only, or nightly builds too. */
  readonly channel: UpdateChannel;
  /** Whether the page reports a save under way. */
  readonly saving: boolean;
  /** Whether this build installs a newer version itself, rather than only saying it is out. */
  readonly installs: boolean;
  /** Whether a verified version installs by itself, as the operator chose ("Update automatically"). */
  readonly automatic: boolean;
  /** Where the update the app makes as it starts stands. */
  readonly launch: LaunchUpdate;
  /** Whether the app is restarting on the version it runs, which nothing installs into as it quits. */
  readonly relaunching: boolean;
}

export type UpdateEvent =
  /** A check starts: at launch, on the schedule, or when the operator asks. */
  | { readonly _tag: "check-started" }
  | { readonly _tag: "not-available" }
  /** A newer version was found; where the build installs, its download starts at once. */
  | { readonly _tag: "available"; readonly version: string }
  | { readonly _tag: "progress"; readonly percent: number }
  | { readonly _tag: "downloaded"; readonly version: string }
  /** The download of `version` matched the release's signed checksums (`matched`), or did not. */
  | { readonly _tag: "verified"; readonly version: string; readonly matched: boolean }
  /** A check, a download or an install failed. */
  | { readonly _tag: "failed" }
  /** The page reports whether a save is under way; a page that went away has none. */
  | { readonly _tag: "saving"; readonly saving: boolean }
  /** The operator pressed "Restart to update". */
  | { readonly _tag: "restart-requested" }
  /** The operator called off a restart that waits for a save. */
  | { readonly _tag: "restart-cancelled" }
  /** The operator chose the releases the app follows. */
  | { readonly _tag: "channel-chosen"; readonly channel: UpdateChannel }
  /** The operator turned "Update automatically" on or off. */
  | { readonly _tag: "automatic-chosen"; readonly on: boolean }
  /** The launch's check has had all the time a launch waits for it. */
  | { readonly _tag: "launch-wait-over" }
  /** The launch's download stalled, or has taken all the time a launch gives it. */
  | { readonly _tag: "launch-download-slow" }
  /** The page asks the app to restart, as after a keyring is unlocked. */
  | { readonly _tag: "relaunch-requested" }
  /** The app quits for good: its window has closed, and the server it ran has stopped. */
  | { readonly _tag: "quitting" };

/** What the updater does after a step, besides reporting the new phase. */
export type Action =
  /** Checks the download of `version` against the release's signed checksums. */
  | { readonly _tag: "verify"; readonly version: string }
  /** Quits and installs the downloaded version now, then starts it. */
  | { readonly _tag: "install" }
  /** Installs the downloaded version as the app goes, without starting it. */
  | { readonly _tag: "install-on-quit" }
  /** Follows the channel now in `next`, and checks it. */
  | { readonly _tag: "follow-channel" }
  /** Restarts the app on the version it runs. */
  | { readonly _tag: "relaunch" };

export interface Step {
  readonly next: Updates;
  readonly action: Action | null;
}

/**
 * Where a build starts, following `channel`. Where it installs updates and
 * they install by themselves (`automatic`), its first check is the launch's:
 * what that check finds within the launch's wait is installed before the
 * operator starts working.
 */
export const initial = (mode: UpdateMode, channel: UpdateChannel, automatic: boolean): Updates => ({
  phase: mode === "off" ? { _tag: "unavailable" } : { _tag: "idle", checked: false },
  channel,
  saving: false,
  installs: mode === "install",
  automatic,
  launch: mode === "install" && automatic ? "checking" : "over",
  relaunching: false,
});

/** Whether a check may start from `phase`: none is under way, and nothing is downloading or ready. */
const checkable = (phase: UpdatePhase): boolean =>
  phase._tag === "idle" || phase._tag === "failed" || phase._tag === "released";

/** Whether a check may start: none is under way, and nothing is downloading or ready. */
export const mayCheck = ({ phase }: Updates): boolean => checkable(phase);

/**
 * Whether the last check failed to reach the release, as one made before the
 * network is up does: worth trying again soon, unlike a download that did not
 * match or an install that failed, which would only fail the same way.
 */
export const checkFailed = ({ phase }: Updates): boolean =>
  phase._tag === "failed" && phase.stage === "check";

/**
 * Whether the operator may choose another channel now: not while a version
 * is on its way, being checked or installing, so what is found, downloaded
 * and offered always belongs to the channel the app shows.
 */
export const mayChooseChannel = ({ phase }: Updates): boolean =>
  checkable(phase) || phase._tag === "downloaded";

const stay = (current: Updates): Step => ({ next: current, action: null });
const go = (current: Updates, phase: UpdatePhase): Step => ({
  next: { ...current, phase },
  action: null,
});
const install = (current: Updates, version: string): Step => ({
  next: { ...current, phase: { _tag: "installing", version } },
  action: { _tag: "install" },
});
/** The launch's update is over: the app opens, or stays open, as usual. */
const opened = (current: Updates): Updates =>
  current.launch === "over" ? current : { ...current, launch: "over" };
/** Restarts into `version` now, or as soon as no save is under way. */
const restart = (current: Updates, version: string): Step =>
  current.saving
    ? go(current, { _tag: "downloaded", version, restart: "waiting-for-save" })
    : install(current, version);

/** Whether a version is on its way: found, but neither verified nor installing. */
const inFlight = (phase: UpdatePhase): boolean =>
  phase._tag === "checking" || phase._tag === "available" || phase._tag === "downloading";

export const step = (current: Updates, event: UpdateEvent): Step => {
  const { phase } = current;
  if (event._tag === "saving") {
    const next = { ...current, saving: event.saving };
    return !event.saving && phase._tag === "downloaded" && phase.restart === "waiting-for-save"
      ? install(next, phase.version)
      : stay(next);
  }
  switch (event._tag) {
    case "check-started":
      return mayCheck(current) ? go(current, { _tag: "checking" }) : stay(current);
    case "not-available":
      return phase._tag === "checking"
        ? go(opened(current), { _tag: "idle", checked: true })
        : stay(current);
    case "available":
      if (!inFlight(phase)) return stay(current);
      // What the launch's check finds in time is what the app updates to before it opens.
      return go(
        current.launch === "checking" ? { ...current, launch: "updating" } : current,
        current.installs
          ? { _tag: "available", version: event.version }
          : { _tag: "released", version: event.version },
      );
    case "progress":
      return phase._tag === "available" || phase._tag === "downloading"
        ? go(current, {
            _tag: "downloading",
            version: phase.version,
            percent: Math.min(100, Math.max(0, event.percent)),
          })
        : stay(current);
    case "downloaded":
      return inFlight(phase)
        ? {
            next: { ...current, phase: { _tag: "verifying", version: event.version } },
            action: { _tag: "verify", version: event.version },
          }
        : stay(current);
    case "verified":
      // A verdict on another version than the one being checked is stale.
      if (phase._tag !== "verifying" || phase.version !== event.version) return stay(current);
      if (!event.matched) return go(opened(current), { _tag: "failed", stage: "verify" });
      // At launch the app restarts into it at once; while it runs, the
      // restart is offered, and the version installs as the app quits.
      return current.launch === "updating"
        ? restart(current, event.version)
        : go(current, { _tag: "downloaded", version: event.version, restart: "offered" });
    case "failed":
      // A stray error once a version is ready leaves it ready; one while
      // installing means the install failed and the app did not quit.
      if (phase._tag === "installing") {
        return go(opened(current), { _tag: "failed", stage: "install", version: phase.version });
      }
      return inFlight(phase)
        ? go(opened(current), { _tag: "failed", stage: "check" })
        : stay(current);
    case "restart-requested":
      if (phase._tag !== "downloaded" || phase.restart !== "offered") return stay(current);
      return restart(current, phase.version);
    case "restart-cancelled":
      // The version stays ready, and installs as the app quits where it would have.
      return phase._tag === "downloaded" && phase.restart === "waiting-for-save"
        ? go(opened(current), { _tag: "downloaded", version: phase.version, restart: "offered" })
        : stay(current);
    case "channel-chosen":
      if (event.channel === current.channel || !mayChooseChannel(current)) return stay(current);
      // What was found or downloaded on the other channel is not offered.
      return {
        next: {
          ...opened(current),
          channel: event.channel,
          phase: { _tag: "idle", checked: false },
        },
        action: { _tag: "follow-channel" },
      };
    case "automatic-chosen":
      return stay({ ...current, automatic: event.on });
    case "launch-wait-over":
      // Whatever the check finds from now on installs as the app quits.
      return current.launch === "checking" ? stay(opened(current)) : stay(current);
    case "launch-download-slow":
      // The page opens, and the download goes on in the background, to
      // install as the app quits, as one found while it runs does.
      return current.launch === "updating" &&
        (phase._tag === "available" || phase._tag === "downloading")
        ? stay(opened(current))
        : stay(current);
    case "relaunch-requested":
      // The restart goes into the version that would install as the app
      // quits, rather than starting the old one beside its installer.
      return current.automatic && phase._tag === "downloaded"
        ? install(current, phase.version)
        : { next: { ...current, relaunching: true }, action: { _tag: "relaunch" } };
    case "quitting":
      // The page went with the window, and any save it had under way with
      // it: installing now cuts nothing short.
      // A restart on the version that runs, which a version verified since
      // it was asked for must not race with its installer, leaves it for the
      // next launch.
      return current.automatic && !current.relaunching && phase._tag === "downloaded"
        ? {
            next: { ...current, phase: { _tag: "installing", version: phase.version } },
            action: { _tag: "install-on-quit" },
          }
        : stay(current);
  }
};
