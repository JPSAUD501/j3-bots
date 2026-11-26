// SPDX-License-Identifier: AGPL-3.0-or-later
import { type OwnHarness, providerFix } from "@j3-bots/client-runtime/presentation";
import {
  harnessFailureText,
  harnessOutcomeText,
  harnessTaskText,
  type ProviderPlace,
} from "@j3-bots/client-runtime/wording";
import type { ProviderId, ProviderStatus, SignInHarness } from "@j3-bots/contracts";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { useI18n, usePresentation } from "../app/context";
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
 * What fixes a provider the engine cannot run, under its line
 * (`providerFix`): for a harness that is not installed, Install, which the
 * server does, with its progress and a way to cancel; where the server cannot
 * install it, where its maker says how and a way to look again once it is;
 * for one that failed, a way to try again. In local mode, a failure whose
 * cause the line does not already say also says where the server's log is.
 * Nothing for any other state.
 */
export function ProviderFix({
  provider,
  place,
  actions,
}: {
  readonly provider: ProviderStatus;
  readonly place: ProviderPlace;
  readonly actions: ProviderActions;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [asking, setAsking] = useState<Asking>("idle");
  const fix = providerFix(provider);
  if (fix === null) return null;
  const ask = (request: Promise<boolean>) => {
    setAsking("asking");
    void request.then((took) => setAsking(took ? "idle" : "failed"));
  };
  const failure = asking === "failed" && (
    <p role="alert" className="text-xs text-blocked">
      {t(
        fix._tag === "get" || fix._tag === "getting"
          ? "provider.install.requestFailed"
          : "provider.recheckFailed",
      )}
    </p>
  );
  switch (fix._tag) {
    case "get":
      return (
        <div className="flex flex-col gap-1.5">
          {fix.failed !== null && (
            <p role="alert" className="text-xs text-pretty text-blocked">
              {harnessFailureText(fix.failed, i18n)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={asking === "asking"}
              onClick={() => ask(actions.install(fix.harness))}
            >
              <DownloadIcon aria-hidden className="size-3.5" />
              {t(fix.failed === null ? "provider.install" : "provider.retry")}
            </Button>
          </div>
          {failure}
        </div>
      );
    case "getting":
      return (
        <div className="flex flex-col gap-1.5">
          <p role="status" className="text-xs text-pretty text-muted-foreground tabular-nums">
            {harnessTaskText(fix.task, i18n)}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={asking === "asking"}
              onClick={() => ask(actions.cancelInstall(fix.harness))}
            >
              {t("provider.install.cancel")}
            </Button>
          </div>
          {failure}
        </div>
      );
    case "install":
    case "retry":
      return (
        <div className="flex flex-col gap-1.5">
          {fix._tag === "retry" && !fix.rechecking && place === "this-computer" && (
            <p className="text-xs text-pretty text-muted-foreground">{t("provider.failed.log")}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {fix._tag === "install" && fix.page !== null && (
              <Button
                variant="secondary"
                size="sm"
                render={<a href={fix.page} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon aria-hidden className="size-3.5" />
                {t("providers.notFound.install", { harness: provider.name })}
              </Button>
            )}
            <Button
              variant={fix._tag === "retry" ? "secondary" : "ghost-muted"}
              size="sm"
              disabled={asking === "asking"}
              onClick={() => ask(actions.recheck(provider.id))}
            >
              {asking === "asking"
                ? t("provider.checking")
                : t(fix._tag === "retry" ? "provider.retry" : "providers.notFound.lookAgain")}
            </Button>
          </div>
          {failure}
        </div>
      );
  }
}

/**
 * The copy of its harness J3 Bots installed for a provider (`ownHarness`), in
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
