// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorAuthEntry, ConnectorSuggestionEntry } from "@j3-bots/contracts";
import { PlugIcon, PlugZapIcon } from "lucide-react";
import { useId } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { useFocusAfterActions } from "../../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "../CardFrame";
import { Button } from "../ui/button";
import { ConnectorTile } from "./parts";

/**
 * A bot suggests a service it would use for the task at hand. Connect opens
 * the connector's page, or lets the bot use one the operator added; Not now
 * closes the card for good in this conversation. Neither wakes the bot.
 */
export function ConnectorSuggestionCard({
  entry,
  onConnect,
  onDismiss,
  submitting = false,
}: {
  entry: ConnectorSuggestionEntry;
  onConnect: () => void;
  onDismiss: () => void;
  /** An answer is on its way: the card takes no second one. */
  submitting?: boolean;
}) {
  const { t } = useI18n();
  const outcomeId = useId();
  const pending = entry.status._tag === "pending";
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);
  return (
    <CardFrame
      ref={target}
      icon={<PlugIcon />}
      title={t("connectorCard.suggest.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <span className="text-sm text-muted-foreground">{entry.reason}</span>
        </div>
      </div>
      {pending ? (
        <div className="flex flex-wrap justify-end gap-2" {...actions}>
          <Button
            size="sm"
            aria-disabled={submitting}
            onClick={() => {
              if (!submitting) onDismiss();
            }}
          >
            {t("connectorCard.notNow")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            aria-disabled={submitting}
            onClick={() => {
              if (!submitting) onConnect();
            }}
          >
            {t("connectorCard.connect")}
          </Button>
        </div>
      ) : (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {entry.status._tag === "connected"
            ? t("connectorCard.connected", { name: entry.name })
            : t("connectorCard.dismissed")}
        </p>
      )}
    </CardFrame>
  );
}

/**
 * A connector a bot called needs the operator to sign in again. Sign in opens
 * the connector's page with its sign-in started. The card closes once the
 * connector works again, or is removed.
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
