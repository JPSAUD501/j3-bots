// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ProviderStatus, UnavailableReason } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { usageLimitText } from "./status.ts";
import type { TimeContext } from "./time.ts";

/** Whole megabytes, 1 MB being a million bytes, as the download's size is told. */
const megabytes = (bytes: number): number => Math.floor(bytes / 1_000_000);

/**
 * How far the engine's download has come, while the server downloads it:
 * "Downloading the engine… 42 of 180 MB", or "… 42 MB" when the download did
 * not say its size. Null when the engine is not downloading.
 */
export function engineDownload(engine: EngineStatus, { t }: I18n): string | null {
  const { state } = engine;
  if (state._tag !== "starting" || state.install === undefined) return null;
  const { receivedBytes, totalBytes } = state.install;
  return totalBytes === null
    ? t("engine.downloading.progressNoTotal", { received: megabytes(receivedBytes) })
    : t("engine.downloading.progress", {
        received: megabytes(receivedBytes),
        total: megabytes(totalBytes),
      });
}

/**
 * What keeps the engine from running bots, and what the operator can do about
 * it; null when it is ready. While it downloads, the title is how far the
 * download has come (`engineDownload`).
 */
export function engineProblem(
  engine: EngineStatus,
  i18n: I18n,
): { readonly title: string; readonly body: string } | null {
  const { t } = i18n;
  const { state } = engine;
  switch (state._tag) {
    case "ready":
      return null;
    case "starting": {
      const download = engineDownload(engine, i18n);
      return download === null
        ? { title: t("engine.starting.title"), body: t("engine.starting.body") }
        : { title: download, body: t("engine.downloading.body") };
    }
    case "incompatible":
      return {
        title: t("firstRun.incompatible.title"),
        body: t("firstRun.incompatible.body", {
          running: state.runningVersion,
          pinned: engine.pinnedVersion,
        }),
      };
    case "unavailable":
      switch (state.reason) {
        case "down":
          return { title: t("engine.down.title"), body: t("engine.down.body") };
        case "port-in-use":
          return { title: t("engine.portInUse.title"), body: t("engine.portInUse.body") };
        case "install-failed":
          return { title: t("engine.installFailed.title"), body: t("engine.installFailed.body") };
        case "credential-refused":
          return {
            title: t("engine.credentialRefused.title"),
            body: t("engine.credentialRefused.body"),
          };
      }
  }
}

/** How a provider's line is drawn: ready to run bots, waiting on the operator or the engine, blocked, or out of use. */
export type ProviderTone = "ready" | "waiting" | "blocked" | "muted";

/**
 * Where the providers run, as the client words it: `this-computer` where the
 * client runs the server itself (the desktop app in local mode), `server`
 * anywhere else.
 */
export type ProviderPlace = "this-computer" | "server";

/** A provider's state in words, as the engine's list of providers shows it. */
export function providerLine(
  provider: ProviderStatus,
  ctx: TimeContext,
  place: ProviderPlace,
): { readonly text: string; readonly tone: ProviderTone } {
  const { t } = ctx.i18n;
  const { status } = provider;
  switch (status._tag) {
    case "ready":
      return provider.models.length > 0
        ? { text: t("provider.ready"), tone: "ready" }
        : { text: t("provider.noModels"), tone: "waiting" };
    case "sign-in-required":
      return { text: t("provider.notConnected"), tone: "waiting" };
    case "limited":
      return { text: usageLimitText(status.resetsAt, ctx), tone: "blocked" };
    case "unavailable":
      return status.checking
        ? { text: t("provider.checking"), tone: "waiting" }
        : unavailableLine(status.reason, place, ctx);
  }
}

/**
 * A provider's harness version, and the update the operator last asked for,
 * in words; null when the server reports no version, as for a harness it did
 * not find or from a server older than 0.7.1.
 * - `text`: the update while it runs or once it failed; else a newer version
 *   when one is out; else how the last update ended; else the version.
 * - `detail`: the engine's words on a failed update, or, for a newer version
 *   the engine cannot install itself, that the operator updates it the way
 *   they installed it.
 * - `offer`: whether to offer Update (`engine.updateProvider`).
 */
export function providerVersionLine(
  provider: ProviderStatus,
  { t }: I18n,
): { readonly text: string; readonly detail: string | null; readonly offer: boolean } | null {
  const { version, update } = provider;
  if (version === undefined) return null;
  const { installed, latest, canUpdate } = version;
  if (update?.state === "running")
    return { text: t("provider.updating"), detail: null, offer: false };
  if (update?.state === "failed") {
    return {
      text: t("provider.updateFailed"),
      detail: update.detail === undefined ? null : t("provider.detail", { detail: update.detail }),
      offer: canUpdate,
    };
  }
  if (latest !== null) {
    return {
      text:
        installed === null
          ? t("provider.version.newerOnly", { latest })
          : t("provider.version.newer", { installed, latest }),
      detail: canUpdate ? null : t("provider.version.manual"),
      offer: canUpdate,
    };
  }
  switch (update?.state) {
    case "updated":
      return {
        text:
          installed === null
            ? t("provider.updated.noVersion")
            : t("provider.updated", { installed }),
        detail: null,
        offer: false,
      };
    case "current":
      return {
        text:
          installed === null
            ? t("provider.upToDate.noVersion")
            : t("provider.upToDate", { installed }),
        detail: null,
        offer: false,
      };
    case "unknown":
    case undefined:
      return installed === null
        ? null
        : { text: t("provider.version", { installed }), detail: null, offer: false };
  }
}

/** Why a provider the engine is done checking cannot run, in words. */
function unavailableLine(
  reason: UnavailableReason | undefined,
  place: ProviderPlace,
  { i18n: { t } }: TimeContext,
): { readonly text: string; readonly tone: ProviderTone } {
  switch (reason) {
    case "not-installed":
      return {
        text: t(
          place === "this-computer" ? "provider.notInstalled.here" : "provider.notInstalled.server",
        ),
        tone: "waiting",
      };
    case "failed":
      return { text: t("provider.failed"), tone: "blocked" };
    case "disabled":
      return { text: t("provider.disabled"), tone: "muted" };
    case "unknown":
    case undefined:
      return { text: t("provider.unavailable"), tone: "muted" };
  }
}
