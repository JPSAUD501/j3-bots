// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
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
  publisherText,
  signedInText,
} from "@j3-bots/client-runtime/wording";
import type {
  Bot,
  Connector,
  ConnectorGrant,
  ConnectorId,
  FieldKey,
  ToolReview,
} from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useI18n, usePresentation } from "../../app/context";
import { cn } from "../../lib/cn";
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
 * thing that fixes it when they cannot; tool changes held for the operator;
 * the bots that may use it, changed in place; who it is signed in as, where
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
      {connector.review !== null && (
        <ToolReviewBlock
          key={connector.review.revision}
          connector={connector}
          review={connector.review}
          connected={connected}
          intents={intents}
        />
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
  const { t } = useI18n();
  const [sending, setSending] = useState<ConnectorGrant | null>(null);
  const [failed, setFailed] = useState(false);
  // The latest change owns the picker: an answer to one before it is not shown.
  const latest = useRef<ConnectorGrant | null>(null);
  const change = (grant: ConnectorGrant) => {
    if (sameGrant(grant, connector.grant) && sending === null) return;
    latest.current = grant;
    setSending(grant);
    setFailed(false);
    void intents.setBots(connector.id, grant).then((result) => {
      if (latest.current !== grant) return;
      latest.current = null;
      setSending(null);
      setFailed(result._tag === "failed");
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
      {failed && (
        <p role="alert" className="text-xs text-blocked">
          {t("connector.bots.failed")}
        </p>
      )}
    </div>
  );
}

/**
 * The tools a connector changed, held until the operator says: each one new
 * or changed, with what it said before and whether it takes other input now.
 * Until they accept, bots get none of these, and the connector's other tools
 * as before: a changed tool cannot be kept as it was, since its server
 * answers only as it now is. "Not now" stops it asking, with no badge, and
 * Accept still works here. Changes that came after the operator looked are never accepted unseen: the
 * server refuses the answer, and the new list shows here.
 */
function ToolReviewBlock({
  connector,
  review,
  connected,
  intents,
}: {
  connector: Connector;
  review: ToolReview;
  connected: boolean;
  intents: ConnectorsIntents;
}) {
  const { t } = useI18n();
  const [sending, setSending] = useState<"accept" | "keep" | null>(null);
  const [problem, setProblem] = useState<"stale" | "failed" | null>(null);
  const answer = (decision: "accept" | "keep") => {
    if (sending !== null || !connected) return;
    setSending(decision);
    setProblem(null);
    void intents.answerToolReview(connector.id, review.revision, decision).then((result) => {
      setSending(null);
      if (result._tag === "failed") {
        setProblem(refusedWith(result, "tool-review-stale") ? "stale" : "failed");
      }
    });
  };
  return (
    <section
      aria-labelledby={`review-${connector.id}`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-3",
        review.kept ? "border-border" : "border-waiting/45 bg-waiting-surface/40",
      )}
    >
      <h3 id={`review-${connector.id}`} className="text-sm font-semibold">
        {review.kept ? t("connector.review.kept.title") : t("connector.review.title")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {review.kept
          ? t("connector.review.kept.body")
          : t("connector.review.body", { name: connector.name })}
      </p>
      <ul className="flex flex-col gap-3">
        {review.changes.map((change) => (
          <li key={change.tool.name} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{change.tool.title ?? change.tool.name}</span>
              <span className="rounded-pill bg-muted px-2 py-0.5 text-2xs font-medium">
                {change._tag === "added"
                  ? t("connector.review.added")
                  : t("connector.review.changed")}
              </span>
              {change._tag === "changed" && change.inputChanged && (
                <span className="rounded-pill bg-waiting-surface px-2 py-0.5 text-2xs font-medium text-waiting">
                  {t("connector.review.inputChanged")}
                </span>
              )}
            </span>
            {change.tool.description !== "" && (
              <span className="text-sm">{change.tool.description}</span>
            )}
            {change._tag === "changed" &&
              change.previous.description !== change.tool.description && (
                <span className="text-sm text-muted-foreground">
                  {t("connector.review.before", { description: change.previous.description })}
                </span>
              )}
          </li>
        ))}
      </ul>
      {problem !== null && (
        <p role="alert" className="text-sm text-blocked">
          {problem === "stale" ? t("connector.review.stale") : t("connector.review.failed")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          aria-disabled={sending !== null || !connected}
          onClick={() => answer("accept")}
        >
          {t("connector.review.accept")}
        </Button>
        {!review.kept && (
          <Button
            size="sm"
            aria-disabled={sending !== null || !connected}
            onClick={() => answer("keep")}
          >
            {t("connector.review.keep")}
          </Button>
        )}
      </div>
    </section>
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
