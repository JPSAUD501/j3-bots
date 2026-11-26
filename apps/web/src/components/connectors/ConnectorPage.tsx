// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  fieldValues,
  knownCommand,
  sameGrant,
  withoutSecrets,
} from "@j3-bots/client-runtime/presentation";
import { useConnectorSignIn } from "@j3-bots/client-runtime/react";
import {
  connectedText,
  connectFailureText,
  secretRefusalText,
  publisherText,
  serverText,
  signedInText,
} from "@j3-bots/client-runtime/wording";
import type { Bot, Connector, ConnectorGrant, ConnectorId, FieldKey } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useI18n, usePresentation } from "../../app/context";
import { Button } from "../ui/button";
import { Confirm } from "../ui/confirm";
import { SkeletonRows } from "../ui/skeleton";
import { EditCommand, type EditOutcome } from "./CommandConnector";
import {
  BotsPicker,
  ConnectorTile,
  ListingFields,
  PageSection,
  StatusBlock,
  ToolList,
} from "./parts";
import type { ConnectorsIntents } from "./screen";
import { SignInPanel } from "./SignInPanel";

/**
 * What the page last did, which its one message reports: each thing done on it
 * replaces the one before, so an older message never stays above a newer one.
 * Opening it on a connector just added counts, with the sign-in that finishes adding it.
 */
type Outcome =
  | { readonly _tag: "added" }
  | { readonly _tag: "signed-in" }
  | { readonly _tag: "edited"; readonly saved: EditOutcome };

/**
 * A connector the operator added: whether bots can use it now, and the one
 * thing that fixes it when they cannot; the bots that may use it, changed in place; who it is signed in as, where
 * it is reached, what it lets bots do; and Disconnect.
 */
export function ConnectorPage({
  connector,
  loading,
  signInOnOpen,
  added,
  bots,
  connected,
  intents,
  onRemoved,
}: {
  /** Null while the list loads (`loading`), or once it is gone. */
  connector: Connector | null;
  loading: boolean;
  signInOnOpen: boolean;
  added: boolean;
  bots: ReadonlyArray<Bot>;
  connected: boolean;
  intents: ConnectorsIntents;
  onRemoved: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const signIn = useConnectorSignIn({
    connectors: intents,
    route: intents.signInRoute,
    open: intents.openPage,
    connector,
  });
  const [replacing, setReplacing] = useState(false);
  // A command connector's edit, while open.
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(added ? { _tag: "added" } : null);
  // A sign-in reports its own outcome, except the one that finishes adding the connector.
  const startSignIn = (id: ConnectorId) => {
    setOutcome((current) => (current?._tag === "added" ? current : { _tag: "signed-in" }));
    signIn.start(id);
  };

  // A card's Sign in, or a connector just added that signs in, starts it as the page opens:
  // the browser's sign-in for one that signs in there, its form again for one that takes a key.
  const startedOnOpen = useRef(false);
  const connectorId = connector?.id ?? null;
  const startOnOpen = useEffectEvent(() => {
    if (connector?.signIn === "oauth") startSignIn(connector.id);
    else if (connector?.signIn === "fields") setReplacing(true);
  });
  useEffect(() => {
    if (!signInOnOpen || startedOnOpen.current || connectorId === null) return;
    startedOnOpen.current = true;
    startOnOpen();
  }, [signInOnOpen, connectorId]);

  if (connector === null) {
    return (
      <div className="px-4 py-5">
        {loading ? (
          <SkeletonRows count={3} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("connector.gone")}</p>
        )}
      </div>
    );
  }

  const signingIn = signIn.phase._tag !== "idle" && signIn.phase._tag !== "done";
  const reconnect =
    signingIn || !connected
      ? null
      : connector.signIn === "oauth"
        ? () => startSignIn(connector.id)
        : connector.signIn === "fields"
          ? () => {
              setOutcome(null);
              setReplacing(true);
            }
          : null;
  const account =
    connector.account === null ? null : t("connector.signedInAs", { account: connector.account });
  const command = knownCommand(connector);
  const signedIn = signedInText(connector, ctx);
  const server = serverText(connector, ctx.i18n);

  return (
    <div className="flex flex-col gap-6 px-4 py-5">
      <div className="flex items-center gap-3">
        <ConnectorTile name={connector.name} glyph={connector.glyph} size="lg" />
        <div className="flex min-w-0 flex-col">
          <h2 className="display-type truncate text-xl">{connector.name}</h2>
          <p className="text-sm text-muted-foreground">
            {publisherText(connector.publisher, ctx.i18n)}
          </p>
        </div>
      </div>

      {outcome?._tag === "added" && connector.status._tag === "connected" && (
        <p role="status" className="text-sm">
          {connectedText(connector.grant, bots, ctx.i18n)}
        </p>
      )}
      {(outcome?._tag === "added" || outcome?._tag === "signed-in") &&
        signIn.phase._tag === "done" && (
          <p role="status" className="text-sm">
            {t("signIn.done")}
          </p>
        )}
      {outcome?._tag === "edited" && (
        <p role="status" className="text-sm">
          {outcome.saved === "command"
            ? t("connector.editCommand.saved")
            : t("connector.editCommand.savedValues")}
        </p>
      )}
      <StatusBlock
        connector={connector}
        onReconnect={reconnect}
        onOpenSecrets={intents.openSecrets}
      />
      <SignInPanel
        signIn={signIn}
        onRetry={() => startSignIn(connector.id)}
        onOpenSecrets={intents.openSecrets}
      />
      {replacing && (
        <ReplaceFields connector={connector} intents={intents} onDone={() => setReplacing(false)} />
      )}

      <PageSection title={t("connector.bots")}>
        <GrantEditor connector={connector} bots={bots} connected={connected} intents={intents} />
      </PageSection>

      {(account !== null || signedIn !== null) && (
        <p className="text-sm text-muted-foreground">
          {[account, signedIn].filter((part) => part !== null).join(" · ")}
        </p>
      )}

      <PageSection
        title={
          connector.transport._tag === "remote" ? t("connector.address") : t("connector.command")
        }
      >
        {command !== null && editing ? (
          <EditCommand
            connector={connector}
            known={command}
            intents={intents}
            onDone={(saved) => {
              setEditing(false);
              setOutcome(saved === null ? null : { _tag: "edited", saved });
            }}
          />
        ) : (
          <>
            <code className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
              {connector.transport._tag === "remote"
                ? connector.transport.origin
                : connector.transport.program}
            </code>
            {command !== null && (
              <Button
                size="sm"
                className="self-start"
                aria-disabled={!connected}
                onClick={() => {
                  if (!connected) return;
                  setOutcome(null);
                  setEditing(true);
                }}
              >
                {t("connector.editCommand")}
              </Button>
            )}
          </>
        )}
      </PageSection>

      <PageSection title={t("connector.tools")}>
        <ToolList tools={connector.tools} />
        {server !== null && <p className="text-xs text-muted-foreground">{server}</p>}
      </PageSection>

      <Disconnect
        connector={connector}
        connected={connected}
        intents={intents}
        onRemoved={onRemoved}
      />
    </div>
  );
}

/**
 * The bots that may use the connector, saved as the operator changes them.
 * While a change is on its way the picker shows it; one that did not save
 * goes back to what the server holds, and says so.
 */
function GrantEditor({
  connector,
  bots,
  connected,
  intents,
}: {
  connector: Connector;
  bots: ReadonlyArray<Bot>;
  connected: boolean;
  intents: ConnectorsIntents;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [sending, setSending] = useState<ConnectorGrant | null>(null);
  // Why the last change did not take, in words: a secret the connector names, or that it failed.
  const [failed, setFailed] = useState<string | null>(null);
  // The latest change owns the picker: an answer to one before it is not shown.
  const latest = useRef<ConnectorGrant | null>(null);
  const change = (grant: ConnectorGrant) => {
    if (sameGrant(grant, connector.grant) && sending === null) return;
    latest.current = grant;
    setSending(grant);
    setFailed(null);
    void intents.setBots(connector.id, grant).then((result) => {
      if (latest.current !== grant) return;
      latest.current = null;
      setSending(null);
      setFailed(
        result._tag === "failed"
          ? (secretRefusalText(result.failure, i18n) ?? t("connector.bots.failed"))
          : null,
      );
    });
  };
  return (
    <div className="flex flex-col gap-1">
      <BotsPicker
        bots={bots}
        grant={sending ?? connector.grant}
        onChange={change}
        disabled={!connected}
      />
      {sending !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("connector.bots.saving")}
        </p>
      )}
      {failed !== null && (
        <p role="alert" className="text-xs text-blocked">
          {failed}
        </p>
      )}
    </div>
  );
}

/**
 * The connector's fields again, for a new token or key: its secret ones
 * start empty, since none is ever shown again.
 */
function ReplaceFields({
  connector,
  intents,
  onDone,
}: {
  connector: Connector;
  intents: ConnectorsIntents;
  onDone: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [values, setValues] = useState<ReadonlyMap<FieldKey, string>>(new Map());
  const [missing, setMissing] = useState<ReadonlyArray<FieldKey>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        const typed = fieldValues(connector.fields, values);
        if (typed._tag === "invalid") {
          setMissing(typed.missing);
          return;
        }
        setMissing([]);
        setSubmitting(true);
        setFailure(null);
        void intents.update(connector.id, { values: typed.values }).then((result) => {
          setSubmitting(false);
          if (result._tag === "done") {
            // The server keeps them now: none stays in the form.
            setValues(withoutSecrets(connector.fields, values));
            onDone();
          } else {
            setFailure(connectFailureText(result.failure, i18n));
          }
        });
      }}
    >
      <ListingFields
        fields={connector.fields}
        values={values}
        missing={missing}
        readOnly={submitting}
        onChange={(key, value) => setValues(new Map(values).set(key, value))}
      />
      {failure !== null && (
        <p role="alert" className="text-sm text-blocked">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" aria-disabled={submitting}>
          {submitting ? t("connect.submitting") : t("connect.submit")}
        </Button>
        <Button size="sm" variant="ghost-muted" onClick={onDone}>
          {t("signIn.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Removes the connector once the operator confirms; its account at the service stays as it is. */
function Disconnect({
  connector,
  connected,
  intents,
  onRemoved,
}: {
  connector: Connector;
  connected: boolean;
  intents: ConnectorsIntents;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <section className="flex flex-col items-start gap-2 border-t border-border pt-5">
      <Confirm
        trigger={<Button variant="destructive-outline" aria-disabled={pending || !connected} />}
        title={t("connector.disconnect.title", { name: connector.name })}
        body={t(
          connector.transport._tag === "command"
            ? "connector.disconnect.bodyCommand"
            : "connector.disconnect.body",
          { name: connector.name },
        )}
        cancel={t("connector.disconnect.cancel")}
        confirm={t("connector.disconnect")}
        busy={pending || !connected}
        onConfirm={() => {
          setPending(true);
          setFailed(false);
          void intents.remove(connector.id).then((result) => {
            setPending(false);
            if (result._tag === "done") onRemoved();
            else setFailed(true);
          });
        }}
      >
        {pending ? t("connector.disconnect.pending") : t("connector.disconnect")}
      </Confirm>
      {failed && (
        <p role="alert" className="text-sm text-blocked">
          {t("connector.disconnect.failed")}
        </p>
      )}
    </section>
  );
}
