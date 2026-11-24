// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorSearch } from "@j3-bots/client-runtime";
import { addedFrom, listingKey, listingPlace } from "@j3-bots/client-runtime/presentation";
import {
  type Answer,
  useAnswer,
  useConnection,
  useConnectors,
} from "@j3-bots/client-runtime/react";
import { grantText } from "@j3-bots/client-runtime/wording";
import type { Connector, ConnectorListing } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Plus, Search, X } from "lucide-react-native";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Quiet, Section, SkeletonRows, SwitchRow } from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useBotList } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text, TextInput } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";
import { useConnectorsIntents, useOpenConnectors } from "./intents.ts";
import { ConnectorTile, OpenRow, StatusWord } from "./parts.tsx";

type Props = NativeStackScreenProps<Screens, "connectors">;

/** How long a search waits for the operator to stop typing. */
const SEARCH_PAUSE_MS = 250;

const kindNote: Partial<Record<ConnectorListing["connect"], KeyWith>> = {
  "own-app": "connectors.kind.own-app",
  token: "connectors.kind.token",
  command: "connectors.kind.command",
  unsupported: "connectors.kind.unsupported",
};

/**
 * Where the operator finds services for their bots, connects them and looks
 * after them: a search of the gallery, and with nothing typed, their
 * connectors, each with its status and its bots, then what the gallery
 * features; last, adding one of their own. Each opens its page over this one.
 */
export function ConnectorsScreen({ navigation, route }: Props) {
  const i18n = useI18n();
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const intents = useConnectorsIntents();
  const open = useOpenConnectors();
  const bots = useBotList();
  const state = useConnectors();
  const connectors = state._tag === "ready" ? state.value : null;
  const connected = useConnection()._tag === "connected";
  const forBot = route.params?.forBot ?? null;
  const suggestion = route.params?.suggestion ?? null;
  const title = t("connectors.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const featured = useAnswer(`featured:${i18n.locale}`, () => intents.featured(i18n.locale));
  const search = useAnswer<ConnectorSearch>(
    query === "" ? null : `search:${i18n.locale}:${all}:${query}`,
    () => intents.search({ query, language: i18n.locale, all }),
  );
  const searching = typed.trim() !== "";

  const openListing = (listing: ConnectorListing) =>
    open({ at: listingPlace(connectors ?? [], listing), forBot, suggestion });

  const listingRow = (listing: ConnectorListing) => {
    const added = addedFrom(connectors ?? [], listing.ref);
    const note = kindNote[listing.connect];
    return (
      <OpenRow
        key={listingKey(listing.ref)}
        label={listing.name}
        onPress={() => openListing(listing)}
      >
        <ConnectorTile name={listing.name} glyph={listing.glyph} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-base font-medium text-foreground">
            {listing.name}
          </Text>
          <Text numberOfLines={2} className="text-sm text-muted-foreground">
            {listing.summary}
          </Text>
          {added !== undefined ? (
            <StatusWord connector={added} />
          ) : (
            note !== undefined && <Text className="text-xs text-muted-foreground">{t(note)}</Text>
          )}
        </View>
      </OpenRow>
    );
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <View className="gap-2 px-4 pt-3">
        <SearchField value={typed} onChange={setTyped} />
        {!connected && <Quiet>{t("connectors.offline")}</Quiet>}
      </View>

      {searching ? (
        <Section open title={t("connectors.results")}>
          {search.answer._tag === "loading" || query !== typed.trim() ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
              {t("connectors.searching")}
            </Text>
          ) : (
            <Loaded answer={search.answer} onRetry={search.retry}>
              {(found) => (
                <>
                  {found.listings.length === 0 ? (
                    <Quiet>{t("connectors.noResults", { query })}</Quiet>
                  ) : (
                    found.listings.map(listingRow)
                  )}
                  {found.registry === "unavailable" && (
                    <Text className="text-xs text-muted-foreground">
                      {t("connectors.registryUnavailable")}
                    </Text>
                  )}
                </>
              )}
            </Loaded>
          )}
          <SwitchRow
            label={t("connectors.showAll")}
            hint={t("connectors.showAll.hint")}
            value={all}
            onChange={setAll}
          />
        </Section>
      ) : (
        <>
          {connectors === null ? (
            <Section open title={t("connectors.yours")}>
              <SkeletonRows count={1} />
            </Section>
          ) : (
            connectors.length > 0 && (
              <Section open title={t("connectors.yours")}>
                {connectors.map((connector) => (
                  <YourRow
                    key={connector.id}
                    connector={connector}
                    bots={grantText(connector.grant, bots, i18n)}
                    onPress={() =>
                      open({
                        at: {
                          _tag: "connector",
                          connectorId: connector.id,
                          signIn: false,
                          added: false,
                        },
                        forBot,
                        suggestion,
                      })
                    }
                  />
                ))}
              </Section>
            )
          )}
          <Section open title={t("connectors.featured")}>
            {featured.answer._tag === "loading" ? (
              <SkeletonRows count={3} />
            ) : (
              <Loaded answer={featured.answer} onRetry={featured.retry}>
                {(listings) => listings.map(listingRow)}
              </Loaded>
            )}
          </Section>
        </>
      )}

      <Section open title={t("connectors.addOwn")}>
        <OpenRow
          label={t("connectors.addOwn")}
          hint={t("connectors.addOwn.hintPhone")}
          onPress={() => open({ at: { _tag: "add-own" }, forBot, suggestion: null })}
        >
          <View className="size-9 items-center justify-center rounded-md border border-dashed border-border">
            <Icon icon={Plus} color="accent-muted-foreground" />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-medium text-foreground">{t("connectors.addOwn")}</Text>
            <Text className="text-sm text-muted-foreground">
              {t("connectors.addOwn.hintPhone")}
            </Text>
          </View>
        </OpenRow>
      </Section>
    </ScrollView>
  );
}

/** One of the operator's connectors: its status, and which bots may use it. */
function YourRow({
  connector,
  bots,
  onPress,
}: {
  readonly connector: Connector;
  readonly bots: string;
  readonly onPress: () => void;
}) {
  return (
    <OpenRow label={connector.name} onPress={onPress}>
      <ConnectorTile name={connector.name} glyph={connector.glyph} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-base font-medium text-foreground">
          {connector.name}
        </Text>
        <StatusWord connector={connector} />
      </View>
      <Text className="text-xs text-muted-foreground">{bots}</Text>
    </OpenRow>
  );
}

/** The search of the gallery, with a button that clears it once there is something to clear. */
function SearchField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const placeholder = useColor("accent-muted-foreground");
  return (
    <View className="min-h-11 flex-row items-center gap-2 rounded-pill bg-muted ps-3.5 pe-1">
      <Icon icon={Search} color="accent-muted-foreground" />
      <TextInput
        accessibilityLabel={t("connectors.search")}
        value={value}
        onChangeText={onChange}
        placeholder={t("connectors.search")}
        placeholderTextColor={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        className="min-h-11 min-w-0 flex-1 text-base text-foreground"
      />
      {value !== "" && (
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("connectors.search.clear")}
          onPress={() => onChange("")}
          className="size-9 items-center justify-center rounded-pill"
        >
          <Icon icon={X} color="accent-muted-foreground" />
        </PressScale>
      )}
    </View>
  );
}

/** What a read that answered holds, or that it did not answer, with a way to read it again. */
export function Loaded<A>({
  answer,
  onRetry,
  children,
}: {
  readonly answer: Exclude<Answer<A>, { readonly _tag: "loading" }>;
  readonly onRetry: () => void;
  readonly children: (value: A) => ReactNode;
}) {
  const { t } = useI18n();
  if (answer._tag === "ready") return children(answer.value);
  return (
    <View className="items-start gap-2">
      <Quiet>{t("connectors.loadFailed")}</Quiet>
      <Button variant="secondary" label={t("connectors.retry")} onPress={onRetry} />
    </View>
  );
}
