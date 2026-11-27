// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  clockTime,
  refillValues,
  sameGrant,
  withoutSecrets,
} from "@j3-bots/client-runtime/presentation";
import {
  type ConnectorSignIn,
  useConnection,
  useConnectors,
  useConnectorSignIn,
} from "@j3-bots/client-runtime/react";
import {
  connectFailureText,
  secretRefusalText,
  grantText,
  publisherText,
  serverText,
  signedInText,
  signInProblemText,
} from "@j3-bots/client-runtime/wording";
import type { Connector, ConnectorGrant, FieldKey } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DeleteButton, Problem, Quiet, SkeletonRows, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useBotList, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { type ConnectorsIntents, useConnectorsIntents } from "./intents.ts";
import {
  BotsPicker,
  CommandLine,
  ConnectorHeading,
  ListingFields,
  PageSection,
  StatusBlock,
  ServedList,
  skillItems,
  toolItems,
} from "./parts.tsx";

type Props = NativeStackScreenProps<Screens, "connector">;

/**
 * A connector the operator or a bot added: whether bots can use it now, and the one
 * thing that fixes it when they cannot; the bots that may use it, changed in
 * place; who it is signed in as, where it is reached, what it lets bots do and
 * what its server speaks; and Disconnect. A connector that runs
 * a command on the server is only shown here: it is looked after from the
 * computer.
 */
export function ConnectorScreen({ navigation, route }: Props) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const insets = useSafeAreaInsets();
  const intents = useConnectorsIntents();
  const bots = useBotList();
  const connected = useConnection()._tag === "connected";
  const state = useConnectors();
  const { connectorId, signIn: signInOnOpen } = route.params;
  const connector =
    state._tag === "ready"
      ? (state.value.find((candidate) => candidate.id === connectorId) ?? null)
      : null;
  const signIn = useConnectorSignIn({
    connectors: intents,
    route: intents.signInRoute,
    open: intents.openSignIn,
    connector,
  });
  const [replacing, setReplacing] = useState(false);
  useLayoutEffect(() => {
    navigation.setOptions({ title: "" });
  }, [navigation]);

  // A card's Sign in starts it as the page opens:
  // the browser's sign-in for one that signs in there, its form again for one that takes a key.
  const startedOnOpen = useRef(false);
  const shownId = connector?.id ?? null;
  const startOnOpen = useEffectEvent(() => {
    // One that runs on the computer is signed in to there; its page says so.
    if (connector === null || connector.transport._tag === "command") return;
    if (connector.signIn === "oauth") signIn.start(connector.id);
    else if (connector.signIn === "fields") setReplacing(true);
  });
  useEffect(() => {
    if (!signInOnOpen || startedOnOpen.current || shownId === null) return;
    startedOnOpen.current = true;
    startOnOpen();
  }, [signInOnOpen, shownId]);

  if (connector === null) {
    return (
      <Page>
        {state._tag === "loading" ? (
          <SkeletonRows count={3} />
        ) : (
          <Quiet>{t("connector.gone")}</Quiet>
        )}
      </Page>
    );
  }

  const onComputer = connector.transport._tag === "command";
  const signingIn = signIn.phase._tag !== "idle" && signIn.phase._tag !== "done";
  const reconnect =
    signingIn || !connected || onComputer
      ? null
      : connector.signIn === "oauth"
        ? () => signIn.start(connector.id)
        : connector.signIn === "fields"
          ? () => setReplacing(true)
          : null;
  const account =
    connector.account === null ? null : t("connector.signedInAs", { account: connector.account });
  const signedIn = signedInText(connector, ctx);
  const server = serverText(connector, ctx.i18n);

  return (
    <Page>
      <ConnectorHeading
        name={connector.name}
        glyph={connector.glyph}
        publisher={publisherText(connector.publisher, ctx.i18n)}
      />

      {signIn.phase._tag === "done" && (
        <Text accessibilityLiveRegion="polite" className="text-base text-foreground">
          {t("signIn.done")}
        </Text>
      )}
      <StatusBlock
        connector={connector}
        onReconnect={reconnect}
        onOpenSecrets={intents.openSecrets}
      />
      <SignInPanel
        signIn={signIn}
        onRetry={() => signIn.start(connector.id)}
        onOpenSecrets={intents.openSecrets}
      />
      {replacing && (
        <ReplaceFields connector={connector} intents={intents} onDone={() => setReplacing(false)} />
      )}
      {onComputer && <Quiet>{t("connector.onComputer")}</Quiet>}

      <PageSection title={t("connector.bots")}>
        {onComputer ? (
          <Text className="text-base text-foreground">
            {grantText(connector.grant, bots, ctx.i18n)}
          </Text>
        ) : (
          <GrantEditor connector={connector} connected={connected} intents={intents} />
        )}
      </PageSection>

      {(account !== null || signedIn !== null) && (
        <Quiet>{[account, signedIn].filter((part) => part !== null).join(" · ")}</Quiet>
      )}

      <PageSection
        title={
          connector.transport._tag === "remote" ? t("connector.address") : t("connector.command")
        }
      >
        <CommandLine
          text={
            connector.transport._tag === "remote"
              ? connector.transport.origin
              : connector.transport.program
          }
        />
      </PageSection>

      <PageSection title={t("connector.tools")}>
        {connector.tools.length === 0 ? (
          <Quiet>{t("connector.tools.none")}</Quiet>
        ) : (
          <ServedList items={toolItems(connector.tools)} />
        )}
        {server !== null && <Quiet>{server}</Quiet>}
      </PageSection>

      {connector.skills !== undefined && connector.skills.length > 0 && (
        <PageSection title={t("connector.skills")}>
          <ServedList items={skillItems(connector.skills)} />
        </PageSection>
      )}

      {!onComputer && (
        <Disconnect connector={connector} intents={intents} onRemoved={navigation.goBack} />
      )}
      <View style={{ height: insets.bottom }} />
    </Page>
  );
}

function Page({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 24, padding: 16, paddingBottom: 24 }}
    >
      {children}
    </ScrollView>
  );
}

function Panel({ children }: { readonly children: ReactNode }) {
  return <View className="gap-3 rounded-lg border border-border p-3">{children}</View>;
}

/**
 * A connector's sign-in as it goes: the page it opened over the app, and a
 * way to open it again, since the operator may close it; while what came
 * back is on its way to the server, that it is. A sign-in that ended badly
 * says why, and starts again from `onRetry`; one the secrets stop, opens
 * them from `onOpenSecrets`.
 */
function SignInPanel({
  signIn,
  onRetry,
  onOpenSecrets,
}: {
  readonly signIn: ConnectorSignIn;
  readonly onRetry: () => void;
  readonly onOpenSecrets: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const { phase } = signIn;
  switch (phase._tag) {
    case "idle":
    case "done":
      return null;
    case "starting":
    case "finishing":
      return (
        <Panel>
          <Text accessibilityLiveRegion="polite" className="text-base text-foreground">
            {phase._tag === "starting" ? t("signIn.starting") : t("signIn.finishing")}
          </Text>
        </Panel>
      );
    case "failed": {
      return (
        <Panel>
          <Problem>{signInProblemText(phase.problem, ctx.i18n)}</Problem>
          <View className="flex-row flex-wrap gap-2">
            {phase.problem === "secrets-unavailable" ? (
              <Button variant="primary" label={t("connect.openSecrets")} onPress={onOpenSecrets} />
            ) : (
              phase.problem !== "not-paired" && (
                <Button variant="primary" label={t("signIn.retry")} onPress={onRetry} />
              )
            )}
            <Button variant="quiet" label={t("signIn.cancel")} onPress={signIn.cancel} />
          </View>
        </Panel>
      );
    }
    case "waiting":
      return (
        <Panel>
          <Text accessibilityLiveRegion="polite" className="text-base font-medium text-foreground">
            {phase.route === "relay" ? t("signIn.waiting.relay") : t("signIn.waiting")}
          </Text>
          {phase.route === "paste" && (
            <PasteForm refused={phase.pasteRefused} onPaste={signIn.paste} />
          )}
          <View className="flex-row flex-wrap gap-2">
            <Button variant="secondary" label={t("signIn.openAgain")} onPress={signIn.openAgain} />
            <Button variant="quiet" label={t("signIn.cancel")} onPress={signIn.cancel} />
          </View>
          <Text className="text-xs text-muted-foreground">
            {t("signIn.until", { time: clockTime(phase.expiresAt, ctx) })}
          </Text>
        </Panel>
      );
  }
}

/**
 * Where the operator pastes the address the browser landed on, when the
 * server can take the browser back neither itself nor through this app. The
 * field empties as it is sent, and the form lives only while the sign-in waits
 * for an address, so a new wait starts empty.
 */
function PasteForm({
  refused,
  onPaste,
}: {
  readonly refused: boolean;
  readonly onPaste: (address: string) => void;
}) {
  const { t } = useI18n();
  const [address, setAddress] = useState("");
  return (
    <View className="gap-2">
      <Text className="text-sm text-muted-foreground">{t("signIn.paste.steps")}</Text>
      <TextField
        label={t("signIn.paste.label")}
        value={address}
        onChange={setAddress}
        autoCapitalize="none"
        error={refused ? t("signIn.paste.refused") : null}
      />
      <View className="flex-row">
        <Button
          variant="primary"
          label={t("signIn.paste.submit")}
          disabled={address.trim() === ""}
          onPress={() => {
            setAddress("");
            onPaste(address);
          }}
        />
      </View>
    </View>
  );
}

/**
 * The bots that may use the connector, saved as the operator changes them.
 * While a change is on its way the picker shows it; one that did not save
 * goes back to what the server holds, and says so.
 */
function GrantEditor({
  connector,
  connected,
  intents,
}: {
  readonly connector: Connector;
  readonly connected: boolean;
  readonly intents: ConnectorsIntents;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const bots = useBotList();
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
    <View className="gap-1">
      <BotsPicker
        bots={bots}
        grant={sending ?? connector.grant}
        onChange={change}
        disabled={!connected}
      />
      {sending !== null && (
        <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
          {t("connector.bots.saving")}
        </Text>
      )}
      <Problem>{failed}</Problem>
    </View>
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
  readonly connector: Connector;
  readonly intents: ConnectorsIntents;
  readonly onDone: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [values, setValues] = useState<ReadonlyMap<FieldKey, string>>(new Map());
  const [missing, setMissing] = useState<ReadonlyArray<FieldKey>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = () => {
    if (submitting) return;
    const typed = refillValues(connector.fields, values);
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
  };
  return (
    <Panel>
      <ListingFields
        fields={connector.fields}
        values={values}
        missing={missing}
        readOnly={submitting}
        onChange={(key, value) => setValues(new Map(values).set(key, value))}
      />
      <Problem>{failure}</Problem>
      <View className="flex-row flex-wrap gap-2">
        <Button
          variant="primary"
          label={submitting ? t("connect.submitting") : t("connect.submit")}
          onPress={submit}
          held={submitting}
        />
        <Button variant="quiet" label={t("signIn.cancel")} onPress={onDone} />
      </View>
    </Panel>
  );
}

/** Removes the connector once the operator confirms; its account at the service stays as it is. */
function Disconnect({
  connector,
  intents,
  onRemoved,
}: {
  readonly connector: Connector;
  readonly intents: ConnectorsIntents;
  readonly onRemoved: () => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  return (
    <View className="items-start gap-2 border-t border-border pt-5">
      <DeleteButton
        label={t("connector.disconnect")}
        title={t("connector.disconnect.title", { name: connector.name })}
        body={t("connector.disconnect.body", { name: connector.name })}
        cancel={t("connector.disconnect.cancel")}
        onDelete={async () => {
          setFailed(false);
          const result = await intents.remove(connector.id);
          if (result._tag === "done") onRemoved();
          else setFailed(true);
        }}
      />
      <Problem>{failed ? t("connector.disconnect.failed") : null}</Problem>
    </View>
  );
}
