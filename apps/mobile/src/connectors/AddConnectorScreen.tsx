// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import {
  addedPlace,
  type FormProblems,
  initialGrant,
  remoteSource,
} from "@j3-bots/client-runtime/presentation";
import { useConnection } from "@j3-bots/client-runtime/react";
import { connectFailureText } from "@j3-bots/client-runtime/wording";
import type { ConnectorGrant, ConnectorSource } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Redacted from "effect/Redacted";
import { useLayoutEffect, useState } from "react";
import { useConfirm } from "../confirm.tsx";
import { FormScreen, Quiet, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useBotList } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { useConnectorsIntents } from "./intents.ts";
import { BotsPicker, HeaderRows, type KeyedHeader, PageSection, SecretLine } from "./parts.tsx";

type Props = NativeStackScreenProps<Screens, "addConnector">;

/**
 * A connector the gallery does not have, by its address, with any headers
 * and an OAuth client the service gave the operator. An address in their own
 * network is sent once they confirm they meant it. One that runs a command is
 * added from the computer: a phone is no place to review what runs on the
 * server.
 */
export function AddConnectorScreen({ navigation, route }: Props) {
  const i18n = useI18n();
  const { t } = i18n;
  const intents = useConnectorsIntents();
  const confirm = useConfirm();
  const bots = useBotList();
  const connected = useConnection()._tag === "connected";
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<ReadonlyArray<KeyedHeader>>([]);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [grant, setGrant] = useState<ConnectorGrant>(() => initialGrant(bots, route.params.forBot));
  const [problems, setProblems] = useState<FormProblems | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ readonly text: string; readonly vault: boolean } | null>(
    null,
  );
  const title = t("addOwn.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  const send = (source: Extract<ConnectorSource, { readonly _tag: "remote" }>) => {
    setSubmitting(true);
    setFailure(null);
    void intents.add({ source, grant, suggestion: null }).then((result) => {
      setSubmitting(false);
      if (result._tag === "done") {
        // The server keeps them now: none stays in the form.
        setHeaders(headers.map((row) => ({ ...row, value: "" })));
        setClientSecret("");
        const at = addedPlace(result.value);
        if (at._tag === "connector") {
          navigation.replace("connector", {
            connectorId: at.connectorId,
            signIn: at.signIn,
            added: at.added,
          });
        }
      } else if (refusedWith(result, "private-network")) {
        confirm({
          title: t("addOwn.private.title"),
          body: t("addOwn.private.body", { host: new URL(Redacted.value(source.url)).hostname }),
          cancel: t("addOwn.private.cancel"),
          confirm: t("addOwn.private.confirm"),
          tone: "primary",
          onConfirm: () => submit(true),
        });
      } else {
        setFailure({
          text: connectFailureText(result.failure, i18n),
          vault: refusedWith(result, "vault-locked") || refusedWith(result, "vault-not-set-up"),
        });
      }
    });
  };

  const submit = (privateNetwork: boolean) => {
    if (submitting || !connected) return;
    const built = remoteSource({
      name,
      url,
      headers,
      client: { issuer, clientId, clientSecret },
      privateNetwork,
    });
    if (built._tag === "invalid") {
      setProblems(built.problems);
      return;
    }
    setProblems(null);
    if (built.source._tag === "remote") send(built.source);
  };

  return (
    <FormScreen
      problem={failure?.text ?? null}
      offline={!connected}
      actions={
        <>
          {failure?.vault === true && (
            <Button
              variant="secondary"
              label={t("connect.openVault")}
              onPress={intents.openVault}
            />
          )}
          <Button
            variant="primary"
            label={submitting ? t("connect.submitting") : t("addOwn.submit")}
            onPress={() => submit(false)}
            held={submitting}
            disabled={!connected}
          />
        </>
      }
    >
      <TextField
        label={t("addOwn.url")}
        hint={t("addOwn.url.hint")}
        error={problems?.url === true ? t("addOwn.url.invalid") : null}
        placeholder="https://"
        value={url}
        onChange={setUrl}
        readOnly={submitting}
        autoCapitalize="none"
      />
      <TextField
        label={`${t("addOwn.name")} (${t("connect.optional")})`}
        placeholder={t("addOwn.name.placeholder")}
        error={problems?.name === true ? t("connect.required", { field: t("addOwn.name") }) : null}
        value={name}
        onChange={setName}
        readOnly={submitting}
      />
      <PageSection title={t("addOwn.headers")}>
        <Text className="text-xs text-muted-foreground">{t("addOwn.headers.hint")}</Text>
        <HeaderRows
          rows={headers}
          refused={problems?.headers ?? []}
          readOnly={submitting}
          onChange={setHeaders}
        />
      </PageSection>
      <PageSection title={`${t("addOwn.client")} (${t("connect.optional")})`}>
        <Text className="text-xs text-muted-foreground">{t("addOwn.client.hint")}</Text>
        <TextField
          label={t("connect.issuer")}
          hint={t("connect.issuer.hint")}
          error={problems?.issuer === true ? t("connect.issuer.invalid") : null}
          value={issuer}
          onChange={setIssuer}
          readOnly={submitting}
          autoCapitalize="none"
        />
        <TextField
          label={t("connect.clientId")}
          error={
            problems?.clientId === true
              ? t("connect.required", { field: t("connect.clientId") })
              : null
          }
          value={clientId}
          onChange={setClientId}
          readOnly={submitting}
          autoCapitalize="none"
        />
        <SecretLine
          label={t("connect.clientSecret")}
          hint={t("connect.secretHint")}
          problem={null}
          value={clientSecret}
          onChange={setClientSecret}
          readOnly={submitting}
        />
      </PageSection>
      <PageSection title={t("connect.who")}>
        <BotsPicker bots={bots} grant={grant} onChange={setGrant} disabled={submitting} />
      </PageSection>
      <Quiet>{t("addOwn.commandOnComputer")}</Quiet>
    </FormScreen>
  );
}
