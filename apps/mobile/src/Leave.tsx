// SPDX-License-Identifier: AGPL-3.0-or-later
import { useReadable } from "@j3-bots/client-runtime/react";
import { useState } from "react";
import { Alert, View } from "react-native";
import { Text } from "./text.tsx";
import { useI18n } from "./i18n.ts";
import { session } from "./platform/platform.ts";
import { Button } from "./ui.tsx";

/**
 * A button that leaves this phone's pairing once the operator confirms, since
 * its drafts and unsent messages go with it. Success replaces the screen with
 * the pairing screen, so only a failure stays shown.
 */
function Confirmed(props: {
  readonly label: string;
  readonly pendingLabel: string;
  readonly failed: string;
  readonly title: string;
  readonly body: string;
  readonly cancel: string;
  readonly leave: () => Promise<boolean>;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "failed">("idle");
  const leave = () => {
    setStatus("pending");
    void props.leave().then((left) => setStatus(left ? "idle" : "failed"));
  };
  const confirm = () =>
    Alert.alert(props.title, props.body, [
      { text: props.cancel, style: "cancel" },
      { text: props.label, style: "destructive", onPress: leave },
    ]);
  return (
    <View className="gap-1">
      <Button
        label={status === "pending" ? props.pendingLabel : props.label}
        onPress={confirm}
        disabled={status === "pending"}
      />
      {status === "failed" && (
        <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
          {props.failed}
        </Text>
      )}
    </View>
  );
}

/**
 * Leaves the server for another, where it cannot be reached or runs another
 * version: a server whose address changed would otherwise be retried for
 * good. The pairing screen then opens for a new address.
 */
export function ChangeServer() {
  const { t } = useI18n();
  const state = useReadable(session.state);
  if (state._tag !== "open") return null;
  return (
    <Confirmed
      label={t("server.change")}
      pendingLabel={t("server.change.pending")}
      failed={t("server.change.failed")}
      title={t("server.change.title")}
      body={t("server.change.body", { address: state.origin.host })}
      cancel={t("server.change.cancel")}
      leave={session.changeServer}
    />
  );
}

/**
 * Forgets a sign-in this phone cannot read, the way on when reading it keeps
 * failing. The pairing screen then opens.
 */
export function ForgetSignIn() {
  const { t } = useI18n();
  return (
    <Confirmed
      label={t("gate.forget")}
      pendingLabel={t("gate.forget.pending")}
      failed={t("gate.forget.failed")}
      title={t("gate.forget.title")}
      body={t("gate.forget.body")}
      cancel={t("gate.forget.cancel")}
      leave={session.forget}
    />
  );
}
