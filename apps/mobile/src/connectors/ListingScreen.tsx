// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import {
  addedPlace,
  type FormProblems,
  initialGrant,
  listingKey,
  listingSource,
  withoutSecrets,
} from "@j3-bots/client-runtime/presentation";
import { useAnswer, useConnection } from "@j3-bots/client-runtime/react";
import { connectFailureText, publisherText } from "@j3-bots/client-runtime/wording";
import type {
  BotId,
  Connector,
  ConnectorGrant,
  ConnectorListingDetails,
  EntryId,
  FieldKey,
} from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FormScreen, Quiet, SkeletonRows, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useBotList } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { Loaded } from "./ConnectorsScreen.tsx";
import { type ConnectorsIntents, useConnectorsIntents } from "./intents.ts";
import {
  BotsPicker,
  ConnectorHeading,
  ListingFields,
  PageSection,
  SecretLine,
  ToolList,
} from "./parts.tsx";

type Props = NativeStackScreenProps<Screens, "connectorListing">;

/**
 * A gallery entry's page: what it does, in J3 Bots' words for a curated one,
 * the tools it offers when its server lists them before a sign-in, and the
 * form that connects it. Once added, the connector's own page takes this
 * one's place.
 */
export function ListingScreen({ navigation, route }: Props) {
  const i18n = useI18n();
  const { t } = i18n;
  const { ref, name, glyph, forBot, suggestion } = route.params;
  const intents = useConnectorsIntents();
  const details = useAnswer(`${listingKey(ref)}:${i18n.locale}`, () =>
    intents.listing(ref, i18n.locale),
  );
  const listing = details.answer._tag === "ready" ? details.answer.value : null;
  useLayoutEffect(() => {
    navigation.setOptions({ title: "" });
  }, [navigation]);

  const heading = (
    <ConnectorHeading
      name={listing?.name ?? name}
      glyph={listing?.glyph ?? glyph}
      publisher={listing === null ? null : publisherText(listing.publisher, i18n)}
    />
  );

  // A command runs on the server as the operator's user: it is connected from the computer.
  if (listing !== null && listing.connect !== "command" && listing.connect !== "unsupported") {
    return (
      <ConnectForm
        listing={listing}
        heading={heading}
        forBot={forBot}
        suggestion={suggestion}
        intents={intents}
        onAdded={(connector) => {
          const at = addedPlace(connector);
          if (at._tag === "connector") {
            navigation.replace("connector", {
              connectorId: at.connectorId,
              signIn: at.signIn,
              added: at.added,
            });
          }
        }}
      />
    );
  }
  return (
    <Page>
      {heading}
      {details.answer._tag === "loading" ? (
        <SkeletonRows count={3} />
      ) : (
        <Loaded answer={details.answer} onRetry={details.retry}>
          {(found) => (
            <>
              <About listing={found} />
              {found.connect === "command" ? (
                <>
                  {found.command !== null && (
                    <PageSection title={t("connector.command")}>
                      <CommandLine
                        text={[found.command.command, ...found.command.args].join(" ")}
                      />
                    </PageSection>
                  )}
                  <Quiet>{t("connect.commandOnComputer")}</Quiet>
                </>
              ) : (
                <Quiet>{t("connector.unsupported")}</Quiet>
              )}
              <Tools listing={found} />
            </>
          )}
        </Loaded>
      )}
    </Page>
  );
}

/** A page that only shows, with no form to keep in reach. */
function Page({ children }: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, padding: 16, paddingBottom: insets.bottom + 24 }}
    >
      {children}
    </ScrollView>
  );
}

/** What the entry says it does. */
function About({ listing }: { readonly listing: ConnectorListingDetails }) {
  const { t } = useI18n();
  if (listing.description === "") return null;
  return (
    <PageSection title={t("connector.description")}>
      <Text className="text-base text-foreground">{listing.description}</Text>
    </PageSection>
  );
}

/** The tools the entry offers, once its server lists them. */
function Tools({ listing }: { readonly listing: ConnectorListingDetails }) {
  const { t } = useI18n();
  return (
    <PageSection title={t("connector.tools")}>
      {listing.tools === null ? (
        <Quiet>{t("connector.tools.afterConnect")}</Quiet>
      ) : (
        <ToolList tools={listing.tools} />
      )}
    </PageSection>
  );
}

/** A command line, as the server would run it, in the mono face. */
export function CommandLine({ text }: { readonly text: string }) {
  return (
    <View className="rounded-md bg-muted px-3 py-2">
      <Text face="mono" selectable className="text-sm text-foreground">
        {text}
      </Text>
    </View>
  );
}

/**
 * Connect, as the entry asks for it: the steps that set up an app at the
 * service and its client, any fields the entry takes, masked when secret,
 * and the bots that may use it, at first the bot that asked for it or the
 * primary bot. Connect stays in reach under the form, on the keyboard.
 */
function ConnectForm({
  listing,
  heading,
  forBot,
  suggestion,
  intents,
  onAdded,
}: {
  readonly listing: ConnectorListingDetails;
  readonly heading: ReactNode;
  readonly forBot: BotId | null;
  readonly suggestion: EntryId | null;
  readonly intents: ConnectorsIntents;
  readonly onAdded: (connector: Connector) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const bots = useBotList();
  const connected = useConnection()._tag === "connected";
  const ownApp = listing.connect === "own-app";
  const [grant, setGrant] = useState<ConnectorGrant>(() => initialGrant(bots, forBot));
  const [values, setValues] = useState<ReadonlyMap<FieldKey, string>>(new Map());
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [problems, setProblems] = useState<FormProblems | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ readonly text: string; readonly vault: boolean } | null>(
    null,
  );

  const add = () => {
    if (submitting || !connected) return;
    const draft = listingSource({
      ref: listing.ref,
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

  const setupUrl = listing.setup?.url ?? null;
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
            label={submitting ? t("connect.submitting") : t("connect.submit")}
            onPress={add}
            held={submitting}
            disabled={!connected}
          />
        </>
      }
    >
      {heading}
      <About listing={listing} />
      {listing.setup !== null && (
        <PageSection title={ownApp ? t("connect.setup") : t("connect.getOne")}>
          {listing.setup.steps.map((step, index) => (
            <View key={step} className="flex-row gap-2">
              <Text className="text-base text-muted-foreground tabular-nums">{`${index + 1}.`}</Text>
              <Text className="min-w-0 flex-1 text-base text-foreground">{step}</Text>
            </View>
          ))}
          {setupUrl !== null && (
            <View className="items-start">
              <Button
                variant="secondary"
                label={t("connect.setup.open")}
                onPress={() => intents.openPage(setupUrl)}
              />
            </View>
          )}
        </PageSection>
      )}
      {ownApp && (
        <>
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
            hint={t("connect.client.hint")}
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
            label={`${t("connect.clientSecret")} (${t("connect.optional")})`}
            hint={t("connect.secretHint")}
            problem={null}
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
      <Tools listing={listing} />
    </FormScreen>
  );
}
