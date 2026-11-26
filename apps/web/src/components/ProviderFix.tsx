// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OwnHarness } from "@j3-bots/client-runtime/presentation";
import { harnessOutcomeText, harnessTaskText } from "@j3-bots/client-runtime/wording";
import type { ProviderId, SignInHarness } from "@j3-bots/contracts";
import { useState } from "react";
import { usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

/**
 * What a client asks of the server about a provider; each resolves with
 * whether the server took the request:
 * - `recheck`: the engine checks the provider again;
 * - `update`: the engine updates the harness it found, the operator's own,
 *   and says how it goes on the provider's `update`;
 * - `install`: the server installs its own copy of the harness, or updates
 *   that copy to the newest version, and says how it goes on the provider's
 *   `copy`;
 * - `cancelInstall`: it stops the install or update of its copy under way.
 */
export interface ProviderActions {
  readonly recheck: (providerId: ProviderId) => Promise<boolean>;
  readonly update: (providerId: ProviderId) => Promise<boolean>;
  readonly install: (harness: SignInHarness) => Promise<boolean>;
  readonly cancelInstall: (harness: SignInHarness) => Promise<boolean>;
}

type Asking = "idle" | "asking" | "failed";

/**
 * The copy of its harness J3 Bots installed for an account (`ownHarness`), in
 * Settings, where `ProviderUpdate` shows the operator's own: the version it
 * runs and the newest, when that is newer, with Update; an update under way,
 * with a way to cancel it; and how the last install or update ended.
 */
export function OwnHarnessLine({
  own,
  actions,
}: {
  readonly own: OwnHarness;
  readonly actions: ProviderActions;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [asking, setAsking] = useState<Asking>("idle");
  const ask = (request: Promise<boolean>) => {
    setAsking("asking");
    void request.then((took) => setAsking(took ? "idle" : "failed"));
  };
  const version =
    own.newer === null
      ? t("provider.version", { installed: own.version })
      : t("provider.version.newer", { installed: own.version, latest: own.newer });
  return (
    <div className="flex flex-col gap-1.5">
      {own.task === null ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="text-xs text-muted-foreground tabular-nums">{version}</p>
            {own.newer !== null && (
              <Button
                variant="secondary"
                size="sm"
                disabled={asking === "asking"}
                onClick={() => ask(actions.install(own.harness))}
              >
                {t("provider.update")}
              </Button>
            )}
          </div>
          {own.last !== null && (
            <p
              className={cn(
                "text-xs text-pretty",
                own.last._tag === "failed" ? "text-blocked" : "text-muted-foreground",
              )}
            >
              {harnessOutcomeText(own.last, ctx)}
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <p role="status" className="text-xs text-pretty text-muted-foreground tabular-nums">
            {harnessTaskText(own.task, ctx.i18n)}
          </p>
          <Button
            variant="ghost-muted"
            size="sm"
            disabled={asking === "asking"}
            onClick={() => ask(actions.cancelInstall(own.harness))}
          >
            {t("provider.install.cancel")}
          </Button>
        </div>
      )}
      {asking === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("provider.install.requestFailed")}
        </p>
      )}
    </div>
  );
}
