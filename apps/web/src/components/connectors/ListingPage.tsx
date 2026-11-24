// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import {
  type FormProblems,
  initialGrant,
  listingKey,
  listingSource,
  withoutSecrets,
} from "@j3-bots/client-runtime/presentation";
import { connectFailureText, publisherText } from "@j3-bots/client-runtime/wording";
import type {
  Bot,
  BotId,
  Connector,
  ConnectorGlyph,
  ConnectorGrant,
  ConnectorListingDetails,
  EntryId,
  FieldKey,
  ListingRef,
} from "@j3-bots/contracts";
import { useAnswer } from "@j3-bots/client-runtime/react";
import { ExternalLinkIcon } from "lucide-react";
import { useId, useState } from "react";
import { useI18n } from "../../app/context";
import { CommandLine } from "../CommandLine";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm";
import { SkeletonRows } from "../ui/skeleton";
import { type ConnectorsIntents, Failed } from "./screen";
import {
  BotsPicker,
  ConnectorTile,
  LineField,
  ListingFields,
  PageSection,
  ToolList,
} from "./parts";

/**
 * A gallery entry's page: what it does, in J3 Bots' words for a curated one,
 * the tools it offers when its server lists them before a sign-in, and the
 * form that connects it.
 */
export function ListingPage({
  listingRef,
  name,
  glyph,
  intents,
  ...form
}: {
  listingRef: ListingRef;
  /** Its name and glyph, shown while its page loads. */
  name: string;
  glyph: ConnectorGlyph | null;
  bots: ReadonlyArray<Bot>;
  forBot: BotId | null;
  suggestion: EntryId | null;
  connected: boolean;
  intents: ConnectorsIntents;
  onAdded: (connector: Connector) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const details = useAnswer(`${listingKey(listingRef)}:${i18n.locale}`, () =>
    intents.listing(listingRef, i18n.locale),
  );
  const listing = details.answer._tag === "ready" ? details.answer.value : null;
  return (
    <div className="flex flex-col gap-6 px-4 py-5">
      <div className="flex items-center gap-3">
        <ConnectorTile name={listing?.name ?? name} glyph={listing?.glyph ?? glyph} size="lg" />
        <div className="flex min-w-0 flex-col">
          <h2 className="display-type truncate text-xl">{listing?.name ?? name}</h2>
          {listing !== null && (
            <p className="text-sm text-muted-foreground">
              {publisherText(listing.publisher, i18n)}
            </p>
          )}
        </div>
      </div>
      {details.answer._tag === "loading" ? (
        <SkeletonRows count={3} />
      ) : details.answer._tag === "failed" || listing === null ? (
        <Failed text={t("connectors.loadFailed")} onRetry={details.retry} />
      ) : (
        <>
          {listing.description !== "" && (
            <PageSection title={t("connector.description")}>
              <p className="text-sm whitespace-pre-line">{listing.description}</p>
            </PageSection>
          )}
          {listing.connect === "unsupported" ? (
            <p className="text-sm text-muted-foreground">{t("connector.unsupported")}</p>
          ) : (
            <ConnectForm listing={listing} intents={intents} {...form} />
          )}
          <PageSection title={t("connector.tools")}>
            {listing.tools === null ? (
              <p className="text-sm text-muted-foreground">{t("connector.tools.afterConnect")}</p>
            ) : (
              <ToolList tools={listing.tools} />
            )}
          </PageSection>
        </>
      )}
    </div>
  );
}

/**
 * The address to register on the operator's app, in full, to copy: a field
 * would cut it short.
 */
function RedirectAddress({ address }: { address: string }) {
  const { t } = useI18n();
  const labelId = useId();
  const hintId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      className="flex flex-col gap-1"
    >
      <p id={labelId} className="text-xs">
        {t("connect.redirect")}
      </p>
      <CommandLine command={address} copyLabel={t("connect.redirect.copy")} />
      <p id={hintId} className="text-xs text-muted-foreground">
        {t("connect.redirect.hint")}
      </p>
    </div>
  );
}

/**
 * Connect, as the entry asks for it: the steps that set up an app at the
 * service and its client, any fields the entry takes, masked when secret,
 * what a command runs, and the bots that may use it, at first the bot that
 * asked for it or the primary bot. A command runs only once the operator
 * confirms it may run on their server.
 */
function ConnectForm({
  listing,
  bots,
  forBot,
  suggestion,
  connected,
  intents,
  onAdded,
}: {
  listing: ConnectorListingDetails;
  bots: ReadonlyArray<Bot>;
  forBot: BotId | null;
  suggestion: EntryId | null;
  connected: boolean;
  intents: ConnectorsIntents;
  onAdded: (connector: Connector) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const ownApp = listing.connect === "own-app";
  // The entry names the server its app is registered at, so the operator is asked only when it does not.
  const knownIssuer = listing.setup?.issuer ?? null;
  const [grant, setGrant] = useState<ConnectorGrant>(() => initialGrant(bots, forBot));
  const [values, setValues] = useState<ReadonlyMap<FieldKey, string>>(new Map());
  const [typedIssuer, setIssuer] = useState("");
  const issuer = knownIssuer ?? typedIssuer;
  // As the server states it: its own address when the browser returns to it, else this device's loopback.
  const redirect =
    !ownApp || listing.redirects === null
      ? null
      : intents.signInRoute._tag === "server"
        ? listing.redirects.server
        : listing.redirects.loopback;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [problems, setProblems] = useState<FormProblems | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ readonly text: string; readonly vault: boolean } | null>(
    null,
  );
  const [consenting, setConsenting] = useState(false);

  const add = () => {
    const draft = listingSource({
      ref: listing.ref,
      language: i18n.locale,
      fields: listing.fields,
      values,
      client: ownApp ? { issuer, clientId, clientSecret } : null,
    });
    if (draft._tag === "invalid") {
      setProblems(draft.problems);
      return;
    }
    setProblems(null);
    setFailure(null);
    setSubmitting(true);
    void intents.add({ source: draft.source, grant, suggestion }).then((result) => {
      setSubmitting(false);
      if (result._tag === "done") {
        // The server keeps them now: none stays in the form.
        setValues(withoutSecrets(listing.fields, values));
        setClientSecret("");
        onAdded(result.value);
        return;
      }
      setFailure({
        text: connectFailureText(result.failure, i18n),
        vault: refusedWith(result, "vault-locked") || refusedWith(result, "vault-not-set-up"),
      });
    });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting || !connected) return;
        if (listing.connect === "command") setConsenting(true);
        else add();
      }}
    >
      {listing.setup !== null && (
        <PageSection title={ownApp ? t("connect.setup") : t("connect.getOne")}>
          <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm">
            {listing.setup.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {listing.setup.url !== null && (
            <Button
              size="sm"
              className="self-start"
              onClick={() => {
                if (listing.setup?.url) intents.openPage(listing.setup.url);
              }}
            >
              {t("connect.setup.open")}
              <ExternalLinkIcon aria-hidden />
            </Button>
          )}
        </PageSection>
      )}
      {listing.command !== null && (
        <PageSection title={t("connector.command")}>
          <code className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
            {[listing.command.command, ...listing.command.args].join(" ")}
          </code>
        </PageSection>
      )}
      {ownApp && (
        <>
          {redirect !== null && <RedirectAddress address={redirect} />}
          {knownIssuer === null && (
            <LineField
              label={t("connect.issuer")}
              hint={t("connect.issuer.hint")}
              problem={problems?.issuer ? t("connect.issuer.invalid") : null}
              value={typedIssuer}
              onChange={setIssuer}
              readOnly={submitting}
              mono
            />
          )}
          <LineField
            label={t("connect.clientId")}
            hint={t("connect.client.hint")}
            problem={
              problems?.clientId ? t("connect.required", { field: t("connect.clientId") }) : null
            }
            value={clientId}
            onChange={setClientId}
            readOnly={submitting}
            mono
          />
          <LineField
            label={`${t("connect.clientSecret")} (${t("connect.optional")})`}
            hint={t("connect.secretHint")}
            type="password"
            value={clientSecret}
            onChange={setClientSecret}
            readOnly={submitting}
          />
        </>
      )}
      <ListingFields
        fields={listing.fields}
        values={values}
        missing={problems?.missing ?? []}
        readOnly={submitting}
        onChange={(key, value) => setValues(new Map(values).set(key, value))}
      />
      <PageSection title={t("connect.who")}>
        <BotsPicker bots={bots} grant={grant} onChange={setGrant} disabled={submitting} />
      </PageSection>
      {failure !== null && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm text-blocked">{failure.text}</p>
          {failure.vault && (
            <Button size="sm" onClick={intents.openVault}>
              {t("connect.openVault")}
            </Button>
          )}
        </div>
      )}
      {!connected && <p className="text-sm text-muted-foreground">{t("connect.failed.offline")}</p>}
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        aria-disabled={submitting || !connected}
      >
        {submitting ? t("connect.submitting") : t("connect.submit")}
      </Button>
      <ConfirmDialog
        open={consenting}
        onOpenChange={setConsenting}
        title={t("addOwn.consent.title")}
        body={t("addOwn.consent.body")}
        cancel={t("addOwn.consent.cancel")}
        confirm={t("addOwn.consent.confirm")}
        tone="primary"
        onConfirm={add}
      />
    </form>
  );
}
