// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IntentResult } from "@j3-bots/client-runtime";
import {
  type OwnAppClient,
  type OwnAppSetup,
  ownAppClient,
} from "@j3-bots/client-runtime/presentation";
import { useAnswer } from "@j3-bots/client-runtime/react";
import type { ConnectorAskEntry, ListingRef } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { ExternalLinkIcon, PlugZapIcon } from "lucide-react";
import { useId, useState } from "react";
import { useBots, useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { type FocusWatch, useFocusAfterActions } from "../../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "../CardFrame";
import { CommandLine } from "../CommandLine";
import { Button } from "../ui/button";
import { ConnectorTile, LineField, PageSection } from "./parts";

type Closed = Exclude<ConnectorAskEntry["status"], { readonly _tag: "pending" }>;

/** How the ask closed, in a sentence that names the bot, and the connector where it was allowed. */
const closedText = (status: Closed, bot: string, name: string, t: I18n["t"]): string => {
  switch (status._tag) {
    case "added":
      return t("connectorAsk.closed.added", { bot, name });
    case "declined":
      return t("connectorAsk.closed.declined", { bot });
    case "failed":
      return t("connectorAsk.closed.failed", { bot, name });
    case "expired":
      return t("connectorAsk.closed.expired", { bot });
  }
};

const refKey = (ref: ListingRef) =>
  ref._tag === "curated" ? `curated:${ref.key}` : `registry:${ref.name}`;

/**
 * A bot asks the operator's yes before it adds a connector that needs it: an
 * address in their own network, named in plain words, or a gallery entry
 * that signs in only with an app they register, whose setup steps the card
 * shows beside the client it takes. The client goes to the server only;
 * the bot never sees it. Once answered, here or elsewhere, or once it waited
 * too long, the card says how it closed.
 */
export function ConnectorAskCard({
  entry,
  setup,
  onAllow,
  onDecline,
  onOpenPage,
  submitting = false,
}: {
  entry: ConnectorAskEntry;
  /** The own app's setup, in the operator's language, with where its sign-ins return on this device. */
  setup: (listing: ListingRef) => Promise<IntentResult<OwnAppSetup>>;
  onAllow: (client: OwnAppClient | null) => void;
  onDecline: () => void;
  /** Opens the service's setup page on this device. */
  onOpenPage: (url: string) => void;
  /** An answer is on its way, or the yes is being added: the card takes no second one. */
  submitting?: boolean;
}) {
  const { t } = useI18n();
  const outcomeId = useId();
  const bots = useBots();
  const bot = bots.get(entry.author.botId)?.profile.name ?? t("bot.unknown");
  const pending = entry.status._tag === "pending";
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);
  const { ask } = entry;
  const decline = () => {
    if (!submitting) onDecline();
  };

  return (
    <CardFrame
      ref={target}
      icon={<PlugZapIcon />}
      title={
        ask._tag === "private-network"
          ? t("connectorAsk.title.network")
          : t("connectorAsk.title.ownApp", { name: entry.name })
      }
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <span className="min-w-0 truncate text-sm font-medium">{entry.name}</span>
      </div>
      {pending && (
        <p className="text-sm">
          {ask._tag === "private-network"
            ? t("connectorAsk.network", { bot, host: ask.host })
            : t("connectorAsk.ownApp", { bot, name: entry.name })}
        </p>
      )}
      {!pending ? (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {closedText(entry.status, bot, entry.name, t)}
        </p>
      ) : ask._tag === "own-app" ? (
        <OwnAppForm
          listing={ask.listing}
          bot={bot}
          setup={setup}
          onAllow={(client) => {
            if (!submitting) onAllow(client);
          }}
          onDecline={decline}
          onOpenPage={onOpenPage}
          submitting={submitting}
          focusWatch={actions}
        />
      ) : (
        <div className="flex justify-end gap-2" {...actions}>
          <Button size="sm" aria-disabled={submitting} onClick={decline}>
            {t("connectorAsk.decline")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            aria-disabled={submitting}
            onClick={() => {
              if (!submitting) onAllow(null);
            }}
          >
            {t("connectorAsk.allow")}
          </Button>
        </div>
      )}
    </CardFrame>
  );
}

/**
 * The own app's setup and the client it took, typed here and sent to the
 * server only. Unmounted with the ask, taking what was typed with it.
 */
function OwnAppForm({
  listing,
  bot,
  setup,
  onAllow,
  onDecline,
  onOpenPage,
  submitting,
  focusWatch,
}: {
  listing: ListingRef;
  bot: string;
  setup: (listing: ListingRef) => Promise<IntentResult<OwnAppSetup>>;
  onAllow: (client: OwnAppClient) => void;
  onDecline: () => void;
  onOpenPage: (url: string) => void;
  submitting: boolean;
  focusWatch: FocusWatch;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const steps = useAnswer(`${refKey(listing)}:${i18n.locale}`, () => setup(listing));
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [problem, setProblem] = useState<"client-id" | "client-secret" | null>(null);
  const allow = () => {
    const typed = ownAppClient(clientId, clientSecret);
    if (typed._tag === "invalid") {
      setProblem(typed.problem);
      return;
    }
    setProblem(null);
    onAllow(typed.client);
  };
  const ready = steps.answer._tag === "ready" ? steps.answer.value : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        allow();
      }}
      {...focusWatch}
    >
      {steps.answer._tag === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{t("connectorAsk.setupFailed")}</p>
          <Button size="sm" onClick={steps.retry}>
            {t("connectorAsk.retry")}
          </Button>
        </div>
      ) : (
        ready !== null && <SetupSteps setup={ready} onOpenPage={onOpenPage} />
      )}
      <LineField
        label={t("connectorAsk.clientId")}
        problem={problem === "client-id" ? t("connectorAsk.clientIdRequired") : null}
        value={clientId}
        onChange={setClientId}
        readOnly={submitting}
        mono
      />
      <LineField
        label={t("connectorAsk.clientSecret")}
        problem={problem === "client-secret" ? t("connectorAsk.clientSecretInvalid") : null}
        type="password"
        value={clientSecret}
        onChange={setClientSecret}
        readOnly={submitting}
      />
      <p className="text-xs text-muted-foreground">{t("connectorAsk.unseen", { bot })}</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" aria-disabled={submitting} onClick={onDecline}>
          {t("connectorAsk.decline")}
        </Button>
        <Button type="submit" size="sm" variant="primary" aria-disabled={submitting}>
          {t("connectorAsk.allow")}
        </Button>
      </div>
    </form>
  );
}

/** The steps that register the app, the page they start at, and the address to register on it. */
function SetupSteps({
  setup,
  onOpenPage,
}: {
  setup: OwnAppSetup;
  onOpenPage: (url: string) => void;
}) {
  const { t } = useI18n();
  const labelId = useId();
  const hintId = useId();
  const { url, redirect } = setup;
  return (
    <>
      {setup.steps.length > 0 && (
        <PageSection title={t("connectorAsk.steps")}>
          <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm">
            {setup.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {url !== null && (
            <Button size="sm" className="self-start" onClick={() => onOpenPage(url)}>
              {t("connectorAsk.setupPage")}
              <ExternalLinkIcon aria-hidden />
            </Button>
          )}
        </PageSection>
      )}
      {redirect !== null && (
        <div
          role="group"
          aria-labelledby={labelId}
          aria-describedby={hintId}
          className="flex flex-col gap-1"
        >
          <p id={labelId} className="text-xs">
            {t("connectorAsk.redirect")}
          </p>
          <CommandLine command={redirect} copyLabel={t("connectorAsk.copyRedirect")} />
          <p id={hintId} className="text-xs text-muted-foreground">
            {t("connectorAsk.redirectHint")}
          </p>
        </div>
      )}
    </>
  );
}
