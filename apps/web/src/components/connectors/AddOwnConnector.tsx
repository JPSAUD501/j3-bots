// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import {
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
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm";
import { textField } from "../ui/field";
import { Segmented } from "../ui/segmented";
import { BotsPicker, type KeyedPair, LineField, PageSection, PairRows } from "./parts";
import type { ConnectorsIntents } from "./screen";

type Way = "address" | "command";

/** What the operator is asked to confirm before the source is sent. */
type Asking =
  | { readonly _tag: "private-network"; readonly host: string }
  | { readonly _tag: "command"; readonly source: ConnectorSource }
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
  const argsId = useId();
  const [way, setWay] = useState<Way>("address");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<ReadonlyArray<KeyedPair>>([]);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState<ReadonlyArray<KeyedPair>>([]);
  const [grant, setGrant] = useState<ConnectorGrant>(() => initialGrant(bots, forBot));
  const [problems, setProblems] = useState<FormProblems | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ readonly text: string; readonly vault: boolean } | null>(
    null,
  );

  const draft = (privateNetwork: boolean): SourceDraft =>
    way === "address"
      ? remoteSource({ name, url, headers, client: { clientId, clientSecret }, privateNetwork })
      : commandSource({ name, command, args, env });

  const send = (source: ConnectorSource) => {
    setSubmitting(true);
    setFailure(null);
    void intents.add({ source, grant, suggestion: null }).then((result) => {
      setSubmitting(false);
      if (result._tag === "done") {
        onAdded(result.value);
      } else if (source._tag === "remote" && refusedWith(result, "private-network")) {
        setAsking({ _tag: "private-network", host: new URL(Redacted.value(source.url)).hostname });
      } else {
        setFailure({
          text: connectFailureText(result.failure, i18n),
          vault: refusedWith(result, "vault-locked") || refusedWith(result, "vault-not-set-up"),
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
    if (built.source._tag === "command") setAsking({ _tag: "command", source: built.source });
    else send(built.source);
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
              refused={problems?.headers ?? []}
              readOnly={submitting}
              onChange={setHeaders}
              labels={{
                name: t("addOwn.header.name"),
                value: t("addOwn.header.value"),
                add: t("addOwn.header.add"),
                remove: t("addOwn.header.remove"),
                invalid: t("addOwn.header.invalid"),
              }}
            />
          </PageSection>
          <PageSection title={`${t("addOwn.client")} (${t("connect.optional")})`}>
            <p className="text-xs text-muted-foreground">{t("addOwn.client.hint")}</p>
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
          <LineField
            label={t("addOwn.command")}
            placeholder={t("addOwn.command.placeholder")}
            problem={
              problems?.command ? t("connect.required", { field: t("addOwn.command") }) : null
            }
            value={command}
            onChange={setCommand}
            readOnly={submitting}
            mono
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={argsId} className="text-xs">
              {t("addOwn.args")}
            </label>
            <textarea
              id={argsId}
              rows={3}
              aria-invalid={problems?.args ? true : undefined}
              value={args}
              readOnly={submitting}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setArgs(event.currentTarget.value)}
              className={cn(textField, "py-2 font-mono")}
            />
            <p className="text-xs text-muted-foreground">{t("addOwn.args.hint")}</p>
            {problems?.args && <p className="text-xs text-blocked">{t("addOwn.args.invalid")}</p>}
          </div>
          <PageSection title={t("addOwn.env")}>
            <PairRows
              rows={env}
              refused={problems?.env ?? []}
              readOnly={submitting}
              onChange={setEnv}
              labels={{
                name: t("addOwn.env.name"),
                value: t("addOwn.env.value"),
                add: t("addOwn.env.add"),
                remove: t("addOwn.env.remove"),
                invalid: t("addOwn.env.invalid"),
              }}
            />
          </PageSection>
        </>
      )}

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
      <ConfirmDialog
        open={asking?._tag === "command"}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={t("addOwn.consent.title")}
        body={t("addOwn.consent.body")}
        cancel={t("addOwn.consent.cancel")}
        confirm={t("addOwn.consent.confirm")}
        tone="primary"
        onConfirm={() => {
          if (asking?._tag === "command") send(asking.source);
        }}
      />
    </form>
  );
}
