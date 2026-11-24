// SPDX-License-Identifier: AGPL-3.0-or-later
import { releasePage } from "@j3-bots/desktop-bridge";
import { channelOf } from "@j3-bots/release";
import * as Option from "effect/Option";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import type { DesktopUpdate } from "../shell/data";
import { UpdateChannelChoice } from "./UpdateChannelChoice";
import { Button } from "./ui/button";

/**
 * Whether a newer version of the app waits for the operator: downloaded and
 * ready to restart into, or out for a build that does not install it itself.
 */
export const appUpdateWaiting = ({ status: { phase } }: DesktopUpdate): boolean =>
  phase._tag === "released" || (phase._tag === "downloaded" && phase.restart === "offered");

/**
 * The desktop app's version and where updating it stands: a check, a
 * download or the check of the download against the release's signature
 * under way, "Restart to update" once a newer version is ready, a way to
 * check again otherwise. A build that does not install updates says a newer
 * version is out and links to its release. The app never restarts by itself.
 * With `channel`, the releases it follows, which the operator can change.
 */
export function AppUpdate({
  update,
  channel = false,
  className,
}: {
  update: DesktopUpdate;
  /** Shows the channel the app follows, and lets the operator choose it. */
  channel?: boolean;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const { current, phase } = update.status;
  const line = (() => {
    switch (phase._tag) {
      case "unavailable":
        return t("update.unavailable");
      case "idle":
        return phase.checked ? t("update.upToDate") : null;
      case "checking":
        return t("update.checking");
      case "released":
        return t("update.released", { version: phase.version });
      case "available":
      case "downloading":
        return t("update.downloading", {
          version: phase.version,
          percent: new Intl.NumberFormat(locale, { style: "percent" }).format(
            phase._tag === "available" ? 0 : phase.percent / 100,
          ),
        });
      case "verifying":
        return t("update.verifying", { version: phase.version });
      case "downloaded":
        return phase.restart === "offered"
          ? t("update.ready", { version: phase.version })
          : t("update.waiting");
      case "installing":
        return t("update.installing");
      case "failed":
        switch (phase.stage) {
          case "check":
            return t("update.failed");
          case "verify":
            return t("update.verifyFailed");
          case "install":
            return t("update.installFailed");
        }
    }
  })();
  const changing =
    phase._tag === "checking" ||
    phase._tag === "available" ||
    phase._tag === "downloading" ||
    phase._tag === "verifying" ||
    phase._tag === "installing";
  const onNightly = Option.getOrNull(channelOf(current)) === "nightly";
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm">{t("update.version", { version: current })}</p>
        <p role="status" className="text-xs text-muted-foreground empty:hidden">
          {line}
        </p>
        {phase._tag === "downloaded" && phase.restart === "offered" && (
          <Button size="sm" variant="primary" onClick={update.restart}>
            {t("update.restart")}
          </Button>
        )}
        {phase._tag === "released" && (
          <Button
            size="sm"
            variant="primary"
            render={<a href={releasePage(phase.version)} target="_blank" rel="noreferrer" />}
          >
            {t("update.download")}
          </Button>
        )}
        {(phase._tag === "idle" || phase._tag === "failed") && (
          <Button size="sm" onClick={update.check}>
            {phase._tag === "idle" ? t("update.check") : t("update.retry")}
          </Button>
        )}
      </div>
      {channel && phase._tag !== "unavailable" && (
        <UpdateChannelChoice
          label={t("updateChannel.app")}
          channel={update.status.channel}
          onChange={update.setChannel}
          disabled={changing}
          waitingForStable={update.status.channel === "stable" && onNightly ? current : null}
        />
      )}
    </div>
  );
}
