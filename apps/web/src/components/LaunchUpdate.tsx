// SPDX-License-Identifier: AGPL-3.0-or-later
import { DownloadIcon } from "lucide-react";
import { useI18n } from "../app/context";
import type { DesktopUpdate } from "../shell/data";
import { useUpdateLine } from "./AppUpdate";
import { Centered, Heading, StateMark, Working } from "./EmptyStates";

/**
 * The desktop app updating itself as it starts, in place of everything else
 * until it restarts into the new version: while its check runs, for a few
 * seconds at most, only that it is checking; once it found a version, that
 * version, how far its download has come, and that the app opens again by
 * itself. Nothing here asks the operator for anything.
 */
export function LaunchUpdate({ update }: { update: DesktopUpdate }) {
  const { t } = useI18n();
  const line = useUpdateLine(update);
  const { phase, launch } = update.status;
  const version = "version" in phase ? phase.version : null;
  if (launch === "checking" || version === null) {
    return (
      <Centered>
        <Working />
        <p role="status" className="text-sm text-muted-foreground">
          {t("update.checking")}
        </p>
      </Centered>
    );
  }
  const percent =
    phase._tag === "downloading" ? phase.percent : phase._tag === "available" ? 0 : 100;
  return (
    <Centered>
      <StateMark icon={DownloadIcon} />
      <Heading title={t("launchUpdate.title", { version })} body={t("launchUpdate.body")} />
      <div className="flex w-full max-w-xs flex-col gap-1.5">
        <span aria-hidden className="h-1.5 overflow-hidden rounded-pill bg-muted">
          <span
            className="block h-full rounded-pill bg-foreground transition-[width] duration-(--duration-state)"
            style={{ width: `${percent}%` }}
          />
        </span>
        <p role="status" className="text-xs text-muted-foreground">
          {line}
        </p>
      </div>
    </Centered>
  );
}
