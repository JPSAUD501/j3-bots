// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorsClient } from "@j3-bots/client-runtime";
import type { SignInRoute } from "@j3-bots/client-runtime/react";
import { useI18n } from "../../app/context";
import { Button } from "../ui/button";

/**
 * What the connectors screen asks of the client runtime, and of the device:
 * how a sign-in's browser comes back here (`signInRoute`), opening a page in
 * the system browser, and opening Settings → Secrets.
 */
export interface ConnectorsIntents extends Omit<ConnectorsClient, "state" | "app"> {
  readonly signInRoute: SignInRoute;
  readonly openPage: (url: string) => void;
  readonly openSecrets: () => void;
}

/** A read that did not answer, and a way to read it again. */
export function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Button size="sm" onClick={onRetry}>
        {t("connectors.retry")}
      </Button>
    </div>
  );
}
