// SPDX-License-Identifier: AGPL-3.0-or-later
import { isRunning, type ServerUpdateView } from "@j3-bots/client-runtime";
import { useJ3Client, useServerUpdate, useServerUpdateEnded } from "@j3-bots/client-runtime/react";
import { serverUpdateLine, updateResultLine } from "@j3-bots/client-runtime/wording";
import { useNavigation } from "@react-navigation/native";
import { ChevronRight } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { phoneNoticeLine } from "./phoneWording.ts";
import { ToneLine, useAppUpdateAutomatic, useAppUpdateState } from "./UpdatePanels.tsx";
import { useUpdatePromptEntry } from "./UpdatePrompt.tsx";

// The updates where the operator already looks: one quiet line over the
// roster. It is the way back to the update prompt after "Later", or to an
// update the operator put behind it; it also says how an update another
// device started goes and how it ended, once, and how the app's own update
// goes where "Update automatically" starts it as the app opens.

/** Whether an update is under way on the server, as far as this phone knows. */
export const serverUpdating = (view: ServerUpdateView): boolean =>
  view._tag === "restarting" || (view._tag === "status" && isRunning(view.status.state));

export function UpdateNotice() {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const view = useServerUpdate();
  const ended = useServerUpdateEnded();
  const phone = useAppUpdateState();
  const automatic = useAppUpdateAutomatic();
  const { entry, reopen } = useUpdatePromptEntry();
  const navigation = useNavigation<Navigation>();

  if (entry !== null) {
    return (
      <NoticeRow
        text={
          entry._tag === "offer"
            ? t("updatePrompt.entry.offer", { version: entry.version })
            : t("updatePrompt.entry.running")
        }
        hint={t("updateNotice.open")}
        onOpen={reopen}
      />
    );
  }

  if (ended !== null) {
    const result = updateResultLine(ended, i18n);
    return (
      <View className="gap-2 px-4 py-2">
        <ToneLine
          text={result.text}
          tone={result.tone}
          hint={result.hint}
          command={result.command}
        />
        <View className="items-start">
          <Button label={t("updateNotice.ok")} onPress={client.serverUpdate.dismissEnded} />
        </View>
      </View>
    );
  }

  const server = serverUpdateLine(view, i18n);
  if (server !== null && (serverUpdating(view) || view._tag === "lost")) {
    return (
      <View className="px-4 py-2">
        <ToneLine text={server.text} tone={server.tone} hint={null} command={server.command} />
      </View>
    );
  }

  // The app's update ends in its process closing, so how it goes is said
  // while it does; one that waits for the operator, or did not go through,
  // leads to its place in Settings.
  const app = automatic && phone !== null ? phoneNoticeLine(phone, i18n) : null;
  if (app === null) return null;
  if (app.release === null) {
    return (
      <View className="px-4 py-2">
        <ToneLine text={app.line.text} tone={app.line.tone} hint={null} />
      </View>
    );
  }
  return (
    <NoticeRow
      text={app.line.text}
      hint={t("updateNotice.openSettings")}
      onOpen={() => navigation.navigate("settings", { section: "updates" })}
    />
  );
}

/** A line that opens the update prompt again, or the updates in Settings. */
function NoticeRow(props: {
  readonly text: string;
  /** What a screen reader says pressing it does. */
  readonly hint: string;
  readonly onOpen: () => void;
}) {
  return (
    <View className="px-2">
      <PressScale
        accessibilityRole="button"
        accessibilityHint={props.hint}
        onPress={props.onOpen}
        className="min-h-11 flex-row items-center gap-2 rounded-md px-2 active:bg-muted"
      >
        <View className="size-1.5 rounded-pill bg-accent" />
        <Text className="flex-1 text-sm font-medium text-foreground">{props.text}</Text>
        <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
      </PressScale>
    </View>
  );
}
