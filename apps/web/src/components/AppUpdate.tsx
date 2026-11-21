// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import type { DesktopUpdate } from "../shell/data";
import { Button } from "./ui/button";

/**
 * The desktop app's version and where updating it stands: a check or a
 * download under way, "Restart to update" once a newer version is ready, a
 * way to check again otherwise. The app never restarts by itself.
 */
export function AppUpdate({ update, className }: { update: DesktopUpdate; className?: string }) {
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
      case "available":
      case "downloading":
        return t("update.downloading", {
          version: phase.version,
          percent: new Intl.NumberFormat(locale, { style: "percent" }).format(
            phase._tag === "available" ? 0 : phase.percent / 100,
          ),
        });
      case "downloaded":
        return phase.restart === "offered"
          ? t("update.ready", { version: phase.version })
          : t("update.waiting");
      case "installing":
        return t("update.installing");
      case "failed":
        return t("update.failed");
    }
  })();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="text-sm">{t("update.version", { version: current })}</p>
      <p role="status" className="text-xs text-muted-foreground empty:hidden">
        {line}
      </p>
      {phase._tag === "downloaded" && phase.restart === "offered" && (
        <Button size="sm" variant="primary" onClick={update.restart}>
          {t("update.restart")}
        </Button>
      )}
      {(phase._tag === "idle" || phase._tag === "failed") && (
        <Button size="sm" onClick={update.check}>
          {phase._tag === "idle" ? t("update.check") : t("update.retry")}
        </Button>
      )}
    </div>
  );
}
