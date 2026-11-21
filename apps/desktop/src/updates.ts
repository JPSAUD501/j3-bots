// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdatePhase } from "@j3-bots/desktop-bridge";

// Updating the app, as a pure model: where it stands, and what each thing
// that happens does to it. The updater module feeds it electron-updater's
// events, the page's reports and the operator's requests, and installs only
// when a step says so. Two rules live here and nowhere else: the app never
// restarts by itself, only once the operator asked; and never while the page
// reports a save under way.

/**
 * How a build updates: it downloads and installs a newer version itself
 * (`install`), it only says one is out and where to get it (`notify`), or it
 * does neither (`off`).
 */
export type UpdateMode = "install" | "notify" | "off";

export interface Updates {
  readonly phase: UpdatePhase;
  /** Whether the page reports a save under way. */
  readonly saving: boolean;
  /** Whether this build installs a newer version itself, rather than only saying it is out. */
  readonly installs: boolean;
}

export type UpdateEvent =
  /** A check starts: at launch, on the schedule, or when the operator asks. */
  | { readonly _tag: "check-started" }
  | { readonly _tag: "not-available" }
  /** A newer version was found; where the build installs, its download starts at once. */
  | { readonly _tag: "available"; readonly version: string }
  | { readonly _tag: "progress"; readonly percent: number }
  | { readonly _tag: "downloaded"; readonly version: string }
  /** A check, a download or an install failed. */
  | { readonly _tag: "failed" }
  /** The page reports whether a save is under way; a page that went away has none. */
  | { readonly _tag: "saving"; readonly saving: boolean }
  /** The operator pressed "Restart to update". */
  | { readonly _tag: "restart-requested" };

export interface Step {
  readonly next: Updates;
  /** Quit and install the downloaded version now. */
  readonly install: boolean;
}

/** Where a build starts. */
export const initial = (mode: UpdateMode): Updates => ({
  phase: mode === "off" ? { _tag: "unavailable" } : { _tag: "idle", checked: false },
  saving: false,
  installs: mode === "install",
});

/** Whether a check may start: none is under way, and nothing is downloading or ready. */
export const mayCheck = ({ phase }: Updates): boolean =>
  phase._tag === "idle" || phase._tag === "failed" || phase._tag === "released";

const stay = (current: Updates): Step => ({ next: current, install: false });
const go = (current: Updates, phase: UpdatePhase): Step => ({
  next: { ...current, phase },
  install: false,
});
const install = (current: Updates, version: string): Step => ({
  next: { ...current, phase: { _tag: "installing", version } },
  install: true,
});

/** Whether a version is on its way: found, but neither ready nor installing. */
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
        ? go(current, { _tag: "idle", checked: true })
        : stay(current);
    case "available":
      if (!inFlight(phase)) return stay(current);
      return go(
        current,
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
        ? go(current, { _tag: "downloaded", version: event.version, restart: "offered" })
        : stay(current);
    case "failed":
      // A stray error once a version is ready leaves it ready; one while
      // installing means the install failed and the app did not quit.
      if (phase._tag === "installing") return go(current, { _tag: "failed", stage: "install" });
      return inFlight(phase) ? go(current, { _tag: "failed", stage: "check" }) : stay(current);
    case "restart-requested":
      if (phase._tag !== "downloaded" || phase.restart !== "offered") return stay(current);
      return current.saving
        ? go(current, { ...phase, restart: "waiting-for-save" })
        : install(current, phase.version);
  }
};
