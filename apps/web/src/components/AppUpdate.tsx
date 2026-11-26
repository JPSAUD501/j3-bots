// SPDX-License-Identifier: AGPL-3.0-or-later
import { releasePage } from "@j3-bots/desktop-bridge";
import { channelOf } from "@j3-bots/release";
import * as Option from "effect/Option";
import { useId } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import type { DesktopUpdate } from "../shell/data";
import { UpdateChannelChoice } from "./UpdateChannelChoice";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

/**
 * Whether a newer version of the app waits for the operator: downloaded and
 * ready to restart into, or out for a build that does not install it itself.
 */
export const appUpdateWaiting = ({ status: { phase } }: DesktopUpdate): boolean =>
  phase._tag === "released" || (phase._tag === "downloaded" && phase.restart === "offered");

/**
 * The line that says where updating the app stands, as a sentence; `null`
 * when there is nothing to say, and in a browser (no `update`).
 */
export function useUpdateLine(update: DesktopUpdate | undefined): string | null {
  const { t, locale } = useI18n();
  if (update === undefined) return null;
  const { status } = update;
  const { phase } = status;
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
      if (phase.restart === "waiting-for-save") return t("update.waiting");
      return status.automatic === true
        ? t("update.readyOnQuit", { version: phase.version })
        : t("update.ready", { version: phase.version });
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
}

/**
 * The desktop app's version and where updating it stands: a check, a
 * download or the check of the download against the release's signature
 * under way, "Restart to update" once a newer version is ready, a way to
 * check again otherwise. Where updates install by themselves, a version that
 * is ready installs as the app quits, and the restart only brings it sooner.
 * A build that does not install updates says a newer version is out and
 * links to its release. With `channel`, the releases it follows and whether
 * it updates by itself, which the operator can change.
 */
export function AppUpdate({
  update,
  channel = false,
  className,
}: {
  update: DesktopUpdate;
  /** Shows the channel the app follows and whether it updates by itself, and lets the operator choose. */
  channel?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const { current, phase } = update.status;
  const line = useUpdateLine(update);
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
      {channel && update.status.automatic !== null && (
        <AutomaticUpdates on={update.status.automatic} onChange={update.setAutomatic} />
      )}
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

/** "Update automatically": whether a verified version installs at launch or as the app quits. */
function AutomaticUpdates({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const { t } = useI18n();
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3 self-stretch text-start">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={labelId} className="text-xs">
          {t("update.automatic")}
        </span>
        <span id={hintId} className="text-2xs text-muted-foreground">
          {t("update.automatic.hint")}
        </span>
      </span>
      <Switch
        checked={on}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onCheckedChange={onChange}
      />
    </div>
  );
}
