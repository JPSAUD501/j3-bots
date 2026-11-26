// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorAuthEntry } from "@j3-bots/contracts";
import { PlugZapIcon } from "lucide-react";
import { useId } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { useFocusAfterActions } from "../../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "../CardFrame";
import { Button } from "../ui/button";
import { ConnectorTile } from "./parts";

/**
 * A connector a bot called, or added, needs the operator to sign in. Sign in
 * opens the connector's page with its sign-in started. The card closes once
 * the connector works, or is removed.
 */
export function ConnectorAuthCard({
  entry,
  onSignIn,
}: {
  entry: ConnectorAuthEntry;
  onSignIn: () => void;
}) {
  const { t } = useI18n();
  const outcomeId = useId();
  const pending = entry.status === "pending";
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);
  return (
    <CardFrame
      ref={target}
      icon={<PlugZapIcon />}
      title={t("connectorCard.auth.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <p className="min-w-0 text-sm">{t("connectorCard.auth.body", { name: entry.name })}</p>
      </div>
      {pending ? (
        <div className="flex justify-end" {...actions}>
          <Button size="sm" variant="primary" onClick={onSignIn}>
            {t("connectorCard.signIn")}
          </Button>
        </div>
      ) : (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {entry.status === "signed-in"
            ? t("connectorCard.signedIn")
            : t("connectorCard.removed", { name: entry.name })}
        </p>
      )}
    </CardFrame>
  );
}
