// SPDX-License-Identifier: AGPL-3.0-or-later
import { Cell, isRunning, type ServerUpdateView } from "@j3-bots/client-runtime";
import {
  useJ3Client,
  useReadable,
  useServerUpdate,
  useServerUpdateEnded,
} from "@j3-bots/client-runtime/react";
import { serverUpdateLine, updateResultLine } from "@j3-bots/client-runtime/wording";
import { useNavigation } from "@react-navigation/native";
import { Storage } from "expo-sqlite/kv-store";
import { ChevronRight, X } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { ToneLine, useAppUpdateState } from "./UpdatePanels.tsx";

// The updates where the operator already looks: one quiet line over the
// roster, never a dialog. It says an update is ready, until the operator
// opens it or hides it for that version; how an update under way goes; and
// how one this phone followed ended, once.

/** The versions whose notice the operator hid, kept on this phone. */
const HIDDEN_KEY = {
  server: "j3:updateNoticeHidden.server",
  app: "j3:updateNoticeHidden.app",
} as const;

const read = (key: string): string | null => {
  try {
    return Storage.getItemSync(key);
  } catch {
    return null;
  }
};

const hidden = new Cell<{ readonly server: string | null; readonly app: string | null }>({
  server: read(HIDDEN_KEY.server),
  app: read(HIDDEN_KEY.app),
});

const hide = (versions: { readonly server: string | null; readonly app: string | null }) => {
  const next = {
    server: versions.server ?? hidden.get().server,
    app: versions.app ?? hidden.get().app,
  };
  try {
    if (next.server !== null) Storage.setItemSync(HIDDEN_KEY.server, next.server);
    if (next.app !== null) Storage.setItemSync(HIDDEN_KEY.app, next.app);
  } catch {
    // Hidden until the app restarts.
  }
  hidden.set(next);
};

/** Whether an update is under way on the server, as far as this phone knows. */
export const serverUpdating = (view: ServerUpdateView): boolean =>
  view._tag === "restarting" || (view._tag === "status" && isRunning(view.status.state));

export function UpdateNotice() {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const navigation = useNavigation<Navigation>();
  const view = useServerUpdate();
  const ended = useServerUpdateEnded();
  const phone = useAppUpdateState();
  const hiddenNow = useReadable(hidden);

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

  const serverVersion = server?.offer?.version ?? null;
  const appVersion = phone?._tag === "available" ? phone.release.version : null;
  const newServer =
    serverVersion !== null && serverVersion !== hiddenNow.server ? serverVersion : null;
  const newApp = appVersion !== null && appVersion !== hiddenNow.app ? appVersion : null;
  // One release at a time: the server's first, then the app's once that one is opened or hidden.
  let text: string;
  let shown: { readonly server: string | null; readonly app: string | null };
  if (newServer !== null && newServer === newApp) {
    text = t("updateNotice.both", { version: newServer });
    shown = { server: newServer, app: newApp };
  } else if (newServer !== null) {
    text = t("updateNotice.server", { version: newServer });
    shown = { server: newServer, app: null };
  } else if (newApp !== null) {
    text = t("updateNotice.app", { version: newApp });
    shown = { server: null, app: newApp };
  } else {
    return null;
  }
  return (
    <View className="flex-row items-center gap-1 px-2">
      <PressScale
        accessibilityRole="button"
        accessibilityHint={t("updateNotice.open")}
        onPress={() => navigation.navigate("settings", { section: "updates" })}
        frame={{ flex: 1 }}
        className="min-h-11 flex-row items-center gap-2 rounded-md px-2 active:bg-muted"
      >
        <Text className="flex-1 text-sm font-medium text-foreground">{text}</Text>
        <Icon icon={ChevronRight} size={16} color="accent-muted-foreground" />
      </PressScale>
      <PressScale
        depth="round"
        accessibilityRole="button"
        accessibilityLabel={t("updateNotice.hide")}
        onPress={() => hide(shown)}
        className="size-11 items-center justify-center rounded-pill active:bg-muted"
      >
        <Icon icon={X} size={16} color="accent-muted-foreground" />
      </PressScale>
    </View>
  );
}
