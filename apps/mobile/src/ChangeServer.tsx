// SPDX-License-Identifier: AGPL-3.0-or-later
import { useReadable } from "@j3-bots/client-runtime/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useI18n } from "./i18n.ts";
import { session } from "./session.ts";
import { Button } from "./ui.tsx";

/**
 * Leaves the server for another, where it cannot be reached or runs another
 * version: a server whose address changed would otherwise be retried for
 * good. It asks first, since this phone's pairing there goes, with its drafts
 * and unsent messages; then the pairing screen opens for a new address.
 */
export function ChangeServer() {
  const { t } = useI18n();
  const state = useReadable(session.state);
  // Success replaces this screen with the pairing screen, so only a failure stays shown.
  const [status, setStatus] = useState<"idle" | "pending" | "failed">("idle");
  if (state._tag !== "open") return null;
  const change = () => {
    setStatus("pending");
    void session.changeServer().then((left) => setStatus(left ? "idle" : "failed"));
  };
  const confirm = () =>
    Alert.alert(t("server.change.title"), t("server.change.body", { address: state.origin.host }), [
      { text: t("server.change.cancel"), style: "cancel" },
      { text: t("server.change"), style: "destructive", onPress: change },
    ]);
  return (
    <View className="gap-1">
      <Button
        label={status === "pending" ? t("server.change.pending") : t("server.change")}
        onPress={confirm}
        disabled={status === "pending"}
      />
      {status === "failed" && (
        <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
          {t("server.change.failed")}
        </Text>
      )}
    </View>
  );
}
