// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateTone } from "@j3-bots/client-runtime/wording";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { AppUpdateFailure, AppUpdateState } from "./appUpdate.ts";

/**
 * What the operator can do about the app's update from where it stands:
 * download and install it, install what is already downloaded, allow J3 Bots
 * to install apps, open Google Play, or try again after a failure.
 */
export type PhoneUpdateAction = "update" | "install" | "allow" | "play" | "retry";

export interface PhoneUpdateLine {
  readonly text: string;
  readonly tone: UpdateTone;
  /** What happens next, or what to do; null when the line says it all. */
  readonly hint: string | null;
  readonly action: PhoneUpdateAction | null;
  /** The release's notes, when there is a release to read about. */
  readonly notesUrl: string | null;
}

const line = (
  text: string,
  tone: UpdateTone,
  more: Partial<Omit<PhoneUpdateLine, "text" | "tone">> = {},
): PhoneUpdateLine => ({ text, tone, hint: null, action: null, notesUrl: null, ...more });

const percent = (received: number, total: number | null) =>
  total === null || total <= 0 ? null : Math.min(100, Math.floor((received * 100) / total));

const FAILURES = {
  unreachable: "phoneUpdate.failure.unreachable",
  "digest-mismatch": "phoneUpdate.failure.digestMismatch",
  "not-this-app": "phoneUpdate.failure.notThisApp",
  "not-newer": "phoneUpdate.failure.notNewer",
  conflict: "phoneUpdate.failure.conflict",
  incompatible: "phoneUpdate.failure.incompatible",
  storage: "phoneUpdate.failure.storage",
  blocked: "phoneUpdate.failure.blocked",
  "install-failed": "phoneUpdate.failure.installFailed",
} as const satisfies Record<Exclude<AppUpdateFailure["_tag"], "unverified">, KeyWith>;

/** Why the update did not go through, in words. */
const failureText = (failure: AppUpdateFailure, { t }: I18n): string =>
  failure._tag === "unverified"
    ? t("serverUpdate.refusedRelease", { version: failure.version })
    : t(FAILURES[failure._tag]);

/**
 * The app's own update in one line, with the one thing to do about it. A
 * failure that a new try can mend offers it; one Android or the release
 * refused for good (another signer, an unverified release) offers nothing
 * but a later check.
 */
export function phoneUpdateLine(state: AppUpdateState, i18n: I18n): PhoneUpdateLine {
  const { t } = i18n;
  switch (state._tag) {
    case "play":
      return line(t("phoneUpdate.play"), "quiet", { action: "play" });
    case "unchecked":
      return line(t("phoneUpdate.unchecked"), "quiet");
    case "checking":
      return line(t("update.checking"), "working");
    case "current":
      return line(t("update.upToDate"), "quiet", {
        hint: state.waitingForStable ? t("phoneUpdate.waitingForStable") : null,
      });
    case "available":
      return line(t("phoneUpdate.available", { version: state.release.version }), "offer", {
        hint: t("phoneUpdate.available.hint"),
        action: "update",
        notesUrl: state.release.notesUrl,
      });
    case "downloading": {
      const done = percent(state.received, state.total);
      const version = state.release.version;
      return line(
        done === null
          ? t("serverUpdate.downloadingNoTotal", { version })
          : t("serverUpdate.downloading", { version, percent: done }),
        "working",
      );
    }
    case "verifying":
      return line(t("serverUpdate.verifying"), "working");
    case "permission":
      return line(t("phoneUpdate.permission.title"), "offer", {
        hint: t("phoneUpdate.permission.body"),
        action: "allow",
      });
    case "installing":
      return line(t("phoneUpdate.installing", { version: state.release.version }), "working");
    case "cancelled":
      return line(t("phoneUpdate.cancelled", { version: state.release.version }), "offer", {
        action: "install",
        notesUrl: state.release.notesUrl,
      });
    case "failed": {
      const { failure } = state;
      const again =
        failure._tag === "unreachable" ||
        failure._tag === "digest-mismatch" ||
        failure._tag === "storage" ||
        failure._tag === "install-failed";
      return line(failureText(failure, i18n), "blocked", {
        action: again && state.release !== null ? "retry" : null,
      });
    }
  }
}
