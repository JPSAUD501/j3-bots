// SPDX-License-Identifier: AGPL-3.0-or-later
import { providerFix } from "@j3-bots/client-runtime/presentation";
import type { ProviderPlace } from "@j3-bots/client-runtime/wording";
import type { ProviderId, ProviderStatus } from "@j3-bots/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";

/** Has the engine check a provider again; resolves with whether the engine took the request. */
export type Recheck = (providerId: ProviderId) => Promise<boolean>;

type Asking = "idle" | "asking" | "failed";

/**
 * What fixes a provider the engine cannot run, under its line
 * (`providerFix`): for a harness that is not installed, where its maker says
 * how and a way to look again once it is; for one that failed, a way to try
 * again. In local mode, a failure also says where the server's log is. Nothing
 * for any other state.
 */
export function ProviderFix({
  provider,
  place,
  onRecheck,
}: {
  readonly provider: ProviderStatus;
  readonly place: ProviderPlace;
  readonly onRecheck: Recheck;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState<Asking>("idle");
  const fix = providerFix(provider);
  if (fix === null) return null;
  const recheck = () => {
    setAsking("asking");
    void onRecheck(provider.id).then((took) => setAsking(took ? "idle" : "failed"));
  };
  return (
    <div className="flex flex-col gap-1.5">
      {fix._tag === "retry" && place === "this-computer" && (
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
          onClick={recheck}
        >
          {asking === "asking"
            ? t("provider.checking")
            : t(fix._tag === "retry" ? "provider.retry" : "providers.notFound.lookAgain")}
        </Button>
      </div>
      {asking === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("provider.recheckFailed")}
        </p>
      )}
    </div>
  );
}
