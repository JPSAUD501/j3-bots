// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  EngineInstallFailure,
  EngineStatus,
  HarnessInstallFailure,
  HarnessOutcome,
  HarnessTask,
  ProviderStatus,
  UnavailableReason,
} from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { ownInstall } from "../presentation/engine.ts";
import { usageLimitText } from "./status.ts";
import { type TimeContext, timeInSentence } from "./time.ts";

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
          return {
            title: t("engine.installFailed.title"),
            body: engineInstallFailureText(state.installFailure, i18n),
          };
        case "credential-refused":
          return {
            title: t("engine.credentialRefused.title"),
            body: t("engine.credentialRefused.body"),
          };
      }
  }
}

/** Why the engine's install failed, in words, with what to do; the general sentence for a reason it has none for. */
function engineInstallFailureText(reason: EngineInstallFailure | undefined, { t }: I18n): string {
  switch (reason) {
    case "download":
      return t("engine.installFailed.body.download");
    case "storage":
      return t("engine.installFailed.body.storage");
    case "in-use":
      return t("engine.installFailed.body.inUse");
    case "permission":
      return t("engine.installFailed.body.permission");
    case "unsupported-platform":
      return t("engine.installFailed.body.unsupported");
    case "checksum":
    case "extract":
    case "outside-home":
    case "files":
    case "unknown":
    case undefined:
      return t("engine.installFailed.body");
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
  // J3 Bots' own install says more than the engine's "not found".
  const own = status._tag === "unavailable" ? ownInstall(provider) : null;
  if (own !== null) {
    switch (own._tag) {
      case "installing":
        return { text: installingText(own.task, ctx.i18n), tone: "waiting" };
      case "failed":
        return { text: t("provider.installFailed"), tone: "blocked" };
    }
  }
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
      if (status.checking) return { text: t("provider.checking"), tone: "waiting" };
      // Its check timed out, and the server checks it again on its own.
      if (status.retryAt !== undefined) return { text: t("provider.timedOut"), tone: "waiting" };
      return unavailableLine(status.reason, place, ctx);
  }
}

/**
 * A provider's harness version, and the update the operator last asked for,
 * in words; null when the server reports neither, as for a harness it did
 * not find and was not asked to update, or a server older than 0.8.0.
 * - `text`: the update while it runs or once it did not succeed; else a
 *   newer version when one is out; else that the update finished; else the
 *   version.
 * - `detail`: the engine's words on an update that did not succeed, or, for
 *   a newer version the engine cannot install itself, that the operator
 *   updates it the way they installed it.
 * - `offer`: whether to offer Update (`engine.updateProvider`).
 */
export function providerVersionLine(
  provider: ProviderStatus,
  { t }: I18n,
): { readonly text: string; readonly detail: string | null; readonly offer: boolean } | null {
  const { version, update } = provider;
  const installed = version?.installed ?? null;
  const latest = version?.latest ?? null;
  const offer = version?.canUpdate === true;
  const engineWords =
    update?.detail === undefined ? null : t("provider.detail", { detail: update.detail });
  switch (update?.state) {
    case "running":
      return { text: t("provider.updating"), detail: null, offer: false };
    case "failed":
      return { text: t("provider.updateFailed"), detail: engineWords, offer };
    case "unverified":
      return { text: t("provider.updateUnverified"), detail: engineWords, offer };
    case "updated":
    case "unknown":
    case undefined:
      break;
  }
  if (latest !== null) {
    return {
      text:
        installed === null
          ? t("provider.version.newerOnly", { latest })
          : t("provider.version.newer", { installed, latest }),
      detail: offer ? null : t("provider.version.manual"),
      offer,
    };
  }
  if (update?.state === "updated") {
    return {
      text:
        installed === null
          ? t("provider.updateFinished.noVersion")
          : t("provider.updateFinished", { installed }),
      detail: null,
      offer: false,
    };
  }
  return installed === null
    ? null
    : { text: t("provider.version", { installed }), detail: null, offer: false };
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

/** A first install under way, as a provider's line says it: "Installing… 42 of 230 MB". */
function installingText(task: HarnessTask, { t }: I18n): string {
  if (task._tag !== "downloading" || task.receivedBytes === 0) return t("provider.installing");
  return task.totalBytes === null
    ? t("provider.installing.progressNoTotal", { received: megabytes(task.receivedBytes) })
    : t("provider.installing.progress", {
        received: megabytes(task.receivedBytes),
        total: megabytes(task.totalBytes),
      });
}

/**
 * What an install or update of the server's own copy of a harness is doing,
 * in words: "Downloading… 42 of 370 MB", "Checking the download…", or that
 * it waits for the bots on the provider to finish before it switches.
 */
export function harnessTaskText(task: HarnessTask, { t }: I18n): string {
  switch (task._tag) {
    case "downloading":
      return task.totalBytes === null
        ? t("provider.install.downloadingNoTotal", { received: megabytes(task.receivedBytes) })
        : t("provider.install.downloading", {
            received: megabytes(task.receivedBytes),
            total: megabytes(task.totalBytes),
          });
    case "verifying":
      return t("provider.install.verifying");
    case "waiting":
      return t("provider.install.waiting");
  }
}

/** Why an install or update of the server's own copy of a harness did not finish, in words. */
export function harnessFailureText(reason: HarnessInstallFailure, { t }: I18n): string {
  switch (reason) {
    case "unreachable":
      return t("provider.install.failed.unreachable");
    case "checksum":
      return t("provider.install.failed.checksum");
    case "check":
      return t("provider.install.failed.check");
    case "storage":
      return t("provider.install.failed.storage");
    case "engine":
      return t("provider.install.failed.engine");
    case "in-use":
      return t("provider.install.failed.inUse");
    case "permission":
      return t("provider.install.failed.permission");
    case "outside-home":
      return t("provider.install.failed.outsideHome");
    case "files":
      return t("provider.install.failed.files");
    case "unknown":
      return t("provider.install.failed.unknown");
  }
}

/**
 * How the last install or update of the server's own copy ended, as Settings
 * says it under the version: "Version 2.1.330 installed today at 4:12 PM.",
 * why it failed, or that it was cancelled.
 */
export function harnessOutcomeText(last: HarnessOutcome, ctx: TimeContext): string {
  const { t } = ctx.i18n;
  switch (last._tag) {
    case "installed":
      return t("provider.installed", { version: last.version, when: timeInSentence(last.at, ctx) });
    case "failed":
      return harnessFailureText(last.reason, ctx.i18n);
    case "cancelled":
      return t("provider.updateCancelled");
  }
}
