// SPDX-License-Identifier: AGPL-3.0-or-later
import { isHidden } from "@j3-bots/client-runtime";
import {
  orderRoster,
  rosterKeyOf,
  rosterKeyText,
  rosterTarget,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { fileProblemText } from "@j3-bots/client-runtime/wording";
import type { RosterItem, RosterItemKey } from "@j3-bots/contracts";
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { FlatList, View } from "react-native";
import { Text } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RosterRow } from "../components/RosterRow.tsx";
import { GroupHeader } from "../components/SectionHeader.tsx";
import { useI18n } from "../i18n.ts";
import { useTextLines } from "../lines.tsx";
import { useSideBySide } from "../layout.ts";
import type { Screens } from "../navigation.tsx";
import { rosterSizes } from "../screens/rosterEntries.ts";
import { hiddenItems } from "../screens/rosterItem.ts";
import { useSay } from "../toast.tsx";
import { Body, Centered, Title } from "../ui.tsx";
import { type Put, useWaitingShare, type WaitingShare } from "./incoming.ts";

/** What is being shared, above the list: its text, and how many files come with it. */
function Summary({ waiting }: { readonly waiting: Extract<WaitingShare, { _tag: "shared" }> }) {
  const { plural } = useI18n();
  const { text, url, files } = waiting.shared;
  const said = [text, url].filter((part) => part !== null).join("\n");
  return (
    <View className="gap-1 border-b border-border px-4 py-3">
      {said !== "" && (
        <Text numberOfLines={3} className="text-sm text-foreground">
          {said}
        </Text>
      )}
      {files.length > 0 && (
        <Text className="text-sm text-muted-foreground">{plural("share.files", files.length)}</Text>
      )}
    </View>
  );
}

/** A row of the picker, or the header over the hidden ones. */
type ShareEntry = { readonly kind: "row"; readonly item: RosterItem } | { readonly kind: "hidden" };

/** The roster's rows in its order, then the hidden bots and rooms by name under their header. */
const shareEntries = (items: ReadonlyArray<RosterItem>): ReadonlyArray<ShareEntry> => {
  const row = (item: RosterItem): ShareEntry => ({ kind: "row", item });
  const header: ShareEntry = { kind: "hidden" };
  const hidden = hiddenItems(items);
  return [
    ...orderRoster(items)
      .filter((item) => !isHidden(item))
      .map(row),
    ...(hidden.length === 0 ? [] : [header, ...hidden.map(row)]),
  ];
};

/**
 * Where a share from another app goes: every bot and room, in the roster's
 * order, then the hidden ones under "Hidden conversations". Picking one opens its conversation with the share in its draft,
 * where it waits for Send. Leaving without a pick lets the share go.
 */
export function ShareScreen({ navigation }: NativeStackScreenProps<Screens, "share">) {
  const i18n = useI18n();
  const { t } = i18n;
  const waiting = useWaitingShare();
  const roster = useReadable(useJ3Client().roster);
  const say = useSay();
  const sideBySide = useSideBySide();
  const insets = useSafeAreaInsets();
  const lines = useTextLines();

  useEffect(() => {
    if (waiting === null) {
      // Nothing waits: a share put in a draft, or this screen brought back without one.
      if (navigation.isFocused()) navigation.goBack();
      return;
    }
    return navigation.addListener("beforeRemove", waiting.dismiss);
  }, [navigation, waiting]);

  if (waiting?._tag !== "shared") return <View className="flex-1 bg-background" />;

  const opened = (key: RosterItemKey, put: Put) => {
    switch (put._tag) {
      case "gone":
        return;
      case "busy":
        say(t("share.wait"));
        return;
      case "unread":
        say(t("share.unread"));
        return;
      case "put": {
        if (sideBySide) navigation.popTo("roster", { item: key });
        else navigation.replace("conversation", { item: key });
        const said = put.leftOut
          .map(({ file, problem }) =>
            t("composer.file.failed", { name: file.name, reason: fileProblemText(problem, i18n) }),
          )
          .join(" ");
        if (said !== "") say(said);
      }
    }
  };
  const pick = (key: RosterItemKey) =>
    void waiting.putInDraft(rosterTarget(key)).then((put) => opened(key, put));

  return (
    <View className="flex-1 bg-background">
      <Summary waiting={waiting} />
      {roster._tag === "loading" || lines === null ? (
        <Centered>
          <Title>{t("firstRun.connecting.title")}</Title>
        </Centered>
      ) : (
        <FlatList
          className="flex-1"
          contentContainerStyle={{ paddingBottom: insets.bottom }}
          data={shareEntries(roster.value)}
          keyExtractor={(entry) =>
            entry.kind === "hidden" ? "hidden" : rosterKeyText(rosterKeyOf(entry.item))
          }
          ListEmptyComponent={
            <View className="items-center px-6 py-12">
              <Body>{t("roster.empty")}</Body>
            </View>
          }
          renderItem={({ item: entry }) =>
            entry.kind === "hidden" ? (
              <GroupHeader label={t("roster.hidden")} height={rosterSizes(lines).section} />
            ) : (
              <RosterRow
                item={entry.item}
                height={rosterSizes(lines).row}
                selected={false}
                onOpen={() => pick(rosterKeyOf(entry.item))}
              />
            )
          }
        />
      )}
    </View>
  );
}

/**
 * Opens the picker when a share arrives, over whatever is shown, once the
 * navigation is ready. A share that cannot be read is said, and let go.
 */
export function ShareOpener({
  navigation,
  ready,
}: {
  readonly navigation: NavigationContainerRefWithCurrent<Screens>;
  readonly ready: boolean;
}) {
  const { t } = useI18n();
  const waiting = useWaitingShare();
  const say = useSay();
  useEffect(() => {
    if (waiting === null || !ready) return;
    if (waiting._tag === "unreadable") {
      say(t("share.unreadable"));
      waiting.dismiss();
      return;
    }
    if (navigation.getCurrentRoute()?.name !== "share") navigation.navigate("share");
  }, [waiting, ready, navigation, say, t]);
  return null;
}
