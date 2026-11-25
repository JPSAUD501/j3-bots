// SPDX-License-Identifier: AGPL-3.0-or-later
import { providerVersionLine } from "@j3-bots/client-runtime/wording";
import type { ProviderId, ProviderStatus } from "@j3-bots/contracts";
import { useState } from "react";
import { usePresentation } from "../app/context";
import { Button } from "./ui/button";

/** Has the engine update a provider's harness; resolves with whether the update started. */
export type Update = (providerId: ProviderId) => Promise<boolean>;

type Asking = "idle" | "asking" | "failed";

/**
 * A provider's harness version and its update (`providerVersionLine`), under
 * its line: Update when the engine can install the newer version itself.
 * Nothing when the server reports no version.
 */
export function ProviderUpdate({
  provider,
  onUpdate,
}: {
  readonly provider: ProviderStatus;
  readonly onUpdate: Update;
}) {
  const { i18n } = usePresentation();
  const { t } = i18n;
  const [asking, setAsking] = useState<Asking>("idle");
  const line = providerVersionLine(provider, i18n);
  if (line === null) return null;
  const update = () => {
    setAsking("asking");
    void onUpdate(provider.id).then((started) => setAsking(started ? "idle" : "failed"));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p className="text-xs text-muted-foreground">{line.text}</p>
        {line.offer && (
          <Button variant="secondary" size="sm" disabled={asking === "asking"} onClick={update}>
            {asking === "asking" ? t("provider.updating") : t("provider.update")}
          </Button>
        )}
      </div>
      {line.detail !== null && (
        <p className="text-xs text-pretty break-words text-muted-foreground">{line.detail}</p>
      )}
      {asking === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("provider.updateRefused")}
        </p>
      )}
    </div>
  );
}
