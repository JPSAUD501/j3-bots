// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import {
  type ArgumentsDraft,
  type CommandConsent,
  commandConsent,
  commandSource,
  type FormProblems,
  initialGrant,
  remoteSource,
  type SourceDraft,
} from "@j3-bots/client-runtime/presentation";
import { connectFailureText } from "@j3-bots/client-runtime/wording";
import type { Bot, BotId, Connector, ConnectorGrant, ConnectorSource } from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { useId, useState } from "react";
import { useI18n } from "../../app/context";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm";
import { Segmented } from "../ui/segmented";
import { CommandConsentDialog, CommandFields } from "./CommandConnector";
import { BotsPicker, type KeyedPair, LineField, PageSection, PairRows } from "./parts";
import type { ConnectorsIntents } from "./screen";

type Way = "address" | "command";

/** What the operator is asked to confirm before the source is sent. */
type Asking =
  | { readonly _tag: "private-network"; readonly host: string }
  | {
      readonly _tag: "command";
      readonly source: Extract<ConnectorSource, { readonly _tag: "command" }>;
      readonly consent: CommandConsent;
    }
  | null;

/**
 * A connector the gallery does not have: by its address, with any headers
 * and an OAuth client the service gave the operator, or by a command the
 * server runs, with its arguments and environment. A command runs only once
 * the operator confirms it runs on their server as their user; an address in
 * their own network, once they confirm they meant it.
 */
export function AddOwnConnector({
  bots,
  forBot,
  connected,
  intents,
  onAdded,
}: {
  bots: ReadonlyArray<Bot>;
  forBot: BotId | null;
  connected: boolean;
  intents: ConnectorsIntents;
  onAdded: (connector: Connector) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const wayId = useId();
  const [way, setWay] = useState<Way>("address");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<ReadonlyArray<KeyedPair>>([]);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<ArgumentsDraft>({ _tag: "typed", text: "" });
  const [env, setEnv] = useState<ReadonlyArray<KeyedPair>>([]);
  const [grant, setGrant] = useState<ConnectorGrant>(() => initialGrant(bots, forBot));
  const [problems, setProblems] = useState<FormProblems | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{
    readonly text: string;
    readonly secrets: boolean;
  } | null>(null);

  const draft = (privateNetwork: boolean): SourceDraft =>
    way === "address"
      ? remoteSource({
          name,
          url,
          headers,
          client: { issuer, clientId, clientSecret },
          privateNetwork,
        })
      : commandSource({ name, command, args: args._tag === "typed" ? args.text : "", env });

  const send = (source: ConnectorSource) => {
    setSubmitting(true);
    setFailure(null);
    void intents.add({ source, grant }).then((result) => {
      setSubmitting(false);
      if (result._tag === "done") {
        // The server keeps them now: none stays in the form.
        setHeaders(headers.map((row) => ({ ...row, value: "" })));
        setEnv(env.map((row) => ({ ...row, value: "" })));
        setArgs({ _tag: "typed", text: "" });
        setClientSecret("");
        onAdded(result.value);
      } else if (source._tag === "remote" && refusedWith(result, "private-network")) {
        setAsking({ _tag: "private-network", host: new URL(Redacted.value(source.url)).hostname });
      } else {
        setFailure({
          text: connectFailureText(result.failure, i18n),
          secrets: refusedWith(result, "secrets-unavailable"),
        });
      }
    });
  };

  const submit = (privateNetwork: boolean) => {
    const built = draft(privateNetwork);
    if (built._tag === "invalid") {
      setProblems(built.problems);
      return;
    }
    setProblems(null);
    if (built.source._tag === "command") {
      // A command runs only once the operator confirmed it, every time it is added.
      setAsking({
        _tag: "command",
        source: built.source,
        consent: commandConsent(built.source, null),
      });
    } else {
      send(built.source);
    }
  };

  return (
    <form
      className="flex flex-col gap-5 px-4 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting && connected) submit(false);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span id={wayId} className="sr-only">
          {t("addOwn.title")}
        </span>
        <Segmented
          value={way}
          labelledBy={wayId}
          onChange={(next) => {
            setWay(next);
            setProblems(null);
            setFailure(null);
          }}
          options={[
            { value: "address", label: t("addOwn.byAddress") },
            { value: "command", label: t("addOwn.byCommand") },
          ]}
        />
      </div>

      {way === "address" ? (
        <>
          <LineField
            label={t("addOwn.url")}
            hint={t("addOwn.url.hint")}
            problem={problems?.url ? t("addOwn.url.invalid") : null}
            type="url"
            placeholder="https://"
            value={url}
            onChange={setUrl}
            readOnly={submitting}
            autoFocus
            mono
          />
          <LineField
            label={`${t("addOwn.name")} (${t("connect.optional")})`}
            placeholder={t("addOwn.name.placeholder")}
            problem={problems?.name ? t("connect.required", { field: t("addOwn.name") }) : null}
            value={name}
            onChange={setName}
            readOnly={submitting}
          />
          <PageSection title={t("addOwn.headers")}>
            <p className="text-xs text-muted-foreground">{t("addOwn.headers.hint")}</p>
            <PairRows
              rows={headers}
              problems={(problems?.headers ?? []).map((index) => ({
                index,
                text: t("addOwn.header.invalid"),
              }))}
              readOnly={submitting}
              onChange={setHeaders}
              labels={{
                name: t("addOwn.header.name"),
                value: t("addOwn.header.value"),
                add: t("addOwn.header.add"),
                remove: t("addOwn.header.remove"),
              }}
            />
          </PageSection>
          <PageSection title={`${t("addOwn.client")} (${t("connect.optional")})`}>
            <p className="text-xs text-muted-foreground">{t("addOwn.client.hint")}</p>
            <LineField
              label={t("connect.issuer")}
              hint={t("connect.issuer.hint")}
              problem={problems?.issuer ? t("connect.issuer.invalid") : null}
              value={issuer}
              onChange={setIssuer}
              readOnly={submitting}
              mono
            />
            <LineField
              label={t("connect.clientId")}
              problem={
                problems?.clientId ? t("connect.required", { field: t("connect.clientId") }) : null
              }
              value={clientId}
              onChange={setClientId}
              readOnly={submitting}
              mono
            />
            <LineField
              label={t("connect.clientSecret")}
              hint={t("connect.secretHint")}
              type="password"
              value={clientSecret}
              onChange={setClientSecret}
              readOnly={submitting}
            />
          </PageSection>
        </>
      ) : (
        <>
          <LineField
            label={t("addOwn.name")}
            placeholder={t("addOwn.name.placeholder")}
            problem={problems?.name ? t("connect.required", { field: t("addOwn.name") }) : null}
            value={name}
            onChange={setName}
            readOnly={submitting}
            autoFocus
          />
          <CommandFields
            command={command}
            args={args}
            env={env}
            problems={problems}
            readOnly={submitting}
            editing={false}
            keptNames={[]}
            autoFocus={false}
            onCommand={setCommand}
            onArgs={setArgs}
            onEnv={setEnv}
          />
        </>
      )}

      <PageSection title={t("connect.who")}>
        <BotsPicker bots={bots} grant={grant} onChange={setGrant} disabled={submitting} />
      </PageSection>

      {failure !== null && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm text-blocked">{failure.text}</p>
          {failure.secrets && (
            <Button size="sm" onClick={intents.openSecrets}>
              {t("connect.openSecrets")}
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
        {submitting ? t("connect.submitting") : t("addOwn.submit")}
      </Button>

      <ConfirmDialog
        open={asking?._tag === "private-network"}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={t("addOwn.private.title")}
        body={t("addOwn.private.body", {
          host: asking?._tag === "private-network" ? asking.host : "",
        })}
        cancel={t("addOwn.private.cancel")}
        confirm={t("addOwn.private.confirm")}
        tone="primary"
        onConfirm={() => submit(true)}
      />
      <CommandConsentDialog
        consent={asking?._tag === "command" ? asking.consent : null}
        changed={false}
        onAnswer={(accepted) => {
          if (asking?._tag !== "command") return;
          setAsking(null);
          if (accepted) send(asking.source);
        }}
      />
    </form>
  );
}
