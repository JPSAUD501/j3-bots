// SPDX-License-Identifier: AGPL-3.0-or-later
import { type IntentResult, refusedWith } from "@j3-bots/client-runtime";
import {
  type OwnAppClient,
  type OwnAppSetup,
  ownAppClient,
  ownAppSetup,
} from "@j3-bots/client-runtime/presentation";
import { useAnswer, useJ3Client } from "@j3-bots/client-runtime/react";
import type { ConnectorAskEntry, ListingRef } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { PlugZap } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { Problem, TextField } from "../components/form.tsx";
import { useConnectorsIntents } from "../connectors/intents.ts";
import { CommandLine, ConnectorTile, PageSection } from "../connectors/parts.tsx";
import { useI18n } from "../i18n.ts";
import { useBots } from "../presentation.tsx";
import { SecretField } from "../secrets/SecretsForms.tsx";
import { Text } from "../text.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";

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
export function ConnectorAskCard({ entry }: { readonly entry: ConnectorAskEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const bots = useBots();
  const submitting = useSubmitting(entry.id);
  const pending = entry.status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const bot = bots.get(entry.author.botId)?.profile.name ?? t("bot.unknown");
  const { ask } = entry;
  const allow = (given: OwnAppClient | null) => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "connector-ask", client: given }).then((result) => {
      if (refusedWith(result, "answer")) say(t("connectorAsk.refused"));
    });
  };
  const decline = () => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "dismiss" });
  };
  return (
    <CardFrame
      icon={PlugZap}
      title={
        ask._tag === "private-network"
          ? t("connectorAsk.title.network")
          : t("connectorAsk.title.ownApp", { name: entry.name })
      }
      attention={pending}
    >
      <View className="flex-row items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-base font-medium text-foreground">
          {entry.name}
        </Text>
      </View>
      {pending && (
        <Text className="text-sm text-foreground">
          {ask._tag === "private-network"
            ? t("connectorAsk.network", { bot, host: ask.host })
            : t("connectorAsk.ownApp", { bot, name: entry.name })}
        </Text>
      )}
      {!pending ? (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {closedText(entry.status, bot, entry.name, t)}
        </Text>
      ) : ask._tag === "own-app" ? (
        <OwnAppForm
          listing={ask.listing}
          bot={bot}
          onAllow={allow}
          onDecline={decline}
          submitting={submitting}
        />
      ) : (
        <View className="flex-row flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            label={t("connectorAsk.decline")}
            held={submitting}
            onPress={decline}
          />
          <Button
            variant="primary"
            label={t("connectorAsk.allow")}
            held={submitting}
            onPress={() => allow(null)}
          />
        </View>
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
  onAllow,
  onDecline,
  submitting,
}: {
  readonly listing: ListingRef;
  readonly bot: string;
  readonly onAllow: (client: OwnAppClient) => void;
  readonly onDecline: () => void;
  readonly submitting: boolean;
}) {
  const { t, locale } = useI18n();
  const intents = useConnectorsIntents();
  const setup = (): Promise<IntentResult<OwnAppSetup>> =>
    intents.listing(listing, locale).then((result) =>
      result._tag === "done"
        ? {
            _tag: "done",
            value: ownAppSetup(result.value, intents.signInRoute._tag === "server"),
          }
        : result,
    );
  const steps = useAnswer(`${refKey(listing)}:${locale}`, setup);
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
  return (
    <View className="gap-4">
      {steps.answer._tag === "failed" ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-sm text-muted-foreground">{t("connectorAsk.setupFailed")}</Text>
          <Button variant="outline" label={t("connectorAsk.retry")} onPress={steps.retry} />
        </View>
      ) : (
        steps.answer._tag === "ready" && (
          <SetupSteps setup={steps.answer.value} onOpenPage={intents.openPage} />
        )
      )}
      <TextField
        label={t("connectorAsk.clientId")}
        value={clientId}
        onChange={setClientId}
        error={problem === "client-id" ? t("connectorAsk.clientIdRequired") : null}
        readOnly={submitting}
        autoCapitalize="none"
      />
      <View className="gap-1">
        <SecretField
          label={t("connectorAsk.clientSecret")}
          value={clientSecret}
          onChange={setClientSecret}
          invalid={problem === "client-secret"}
          editable={!submitting}
          onSubmit={allow}
        />
        <Problem>
          {problem === "client-secret" ? t("connectorAsk.clientSecretInvalid") : null}
        </Problem>
      </View>
      <Text className="text-xs text-muted-foreground">{t("connectorAsk.unseen", { bot })}</Text>
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          label={t("connectorAsk.decline")}
          held={submitting}
          onPress={onDecline}
        />
        <Button
          variant="primary"
          label={t("connectorAsk.allow")}
          held={submitting}
          onPress={allow}
        />
      </View>
    </View>
  );
}

/** The steps that register the app, the page they start at, and the address to register on it. */
function SetupSteps({
  setup,
  onOpenPage,
}: {
  readonly setup: OwnAppSetup;
  readonly onOpenPage: (url: string) => void;
}) {
  const { t } = useI18n();
  const { url, redirect } = setup;
  return (
    <>
      {setup.steps.length > 0 && (
        <PageSection title={t("connectorAsk.steps")}>
          {setup.steps.map((step, index) => (
            <Text key={step} className="text-sm text-foreground">
              {`${index + 1}. ${step}`}
            </Text>
          ))}
          {url !== null && (
            <View className="flex-row">
              <Button
                variant="outline"
                label={t("connectorAsk.setupPage")}
                onPress={() => onOpenPage(url)}
              />
            </View>
          )}
        </PageSection>
      )}
      {redirect !== null && (
        <PageSection title={t("connectorAsk.redirect")}>
          <CommandLine text={redirect} />
          <Text className="text-xs text-muted-foreground">{t("connectorAsk.redirectHint")}</Text>
        </PageSection>
      )}
    </>
  );
}
