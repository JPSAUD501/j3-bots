// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { BrowserHelpEntry } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import { AppWindow } from "lucide-react-native";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { useI18n } from "../i18n.ts";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";

const reasonText: Record<BrowserHelpEntry["reason"], KeyWith> = {
  captcha: "browserHelp.reason.captcha",
  login: "browserHelp.reason.login",
  "two-factor": "browserHelp.reason.two-factor",
  "qr-code": "browserHelp.reason.qr-code",
  passkey: "browserHelp.reason.passkey",
  other: "browserHelp.reason.other",
};

type Closed = Exclude<BrowserHelpEntry["status"], { readonly _tag: "pending" }>;

const closedText = (status: Closed): KeyWith => {
  switch (status._tag) {
    case "done":
      return "browserHelp.closed.done";
    case "declined":
      return "browserHelp.closed.declined";
    case "expired":
      return status.cause === "tab-closed"
        ? "browserHelp.closed.tab-closed"
        : "browserHelp.closed.timed-out";
  }
};

/**
 * A bot asking the operator to do one step in its browser that only they can:
 * what the step is, on which site, and the bot's own words. The operator opens
 * the browser, does it there, and says here whether they did. Once answered,
 * here or elsewhere, or expired, the card only says how it ended.
 */
export function BrowserHelpCard({
  entry,
  onOpen,
}: {
  readonly entry: BrowserHelpEntry;
  /** Opens the bot's browser on the card's tab. */
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const submitting = useSubmitting(entry.id);
  const { status } = entry;
  const pending = status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const answer = (choice: "done" | "declined") => () => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "browser-help", outcome: choice });
  };
  return (
    <CardFrame icon={AppWindow} title={t("browserHelp.title")} attention={pending}>
      <View className="gap-1">
        <Text className="text-sm font-medium text-foreground">{t(reasonText[entry.reason])}</Text>
        {entry.site !== "" && (
          <Text className="text-xs text-muted-foreground">
            {t("browserHelp.onSite", { site: entry.site })}
          </Text>
        )}
        <Text className="text-sm text-muted-foreground">{entry.note}</Text>
      </View>
      {status._tag === "pending" ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Button variant="primary" label={t("browser.open")} onPress={onOpen} />
          <View className="ms-auto flex-row gap-2">
            <Button
              variant="outline"
              label={t("browserHelp.cantDoIt")}
              onPress={answer("declined")}
              held={submitting}
            />
            <Button
              variant="outline"
              label={t("browserHelp.done")}
              onPress={answer("done")}
              held={submitting}
            />
          </View>
        </View>
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {t(closedText(status))}
        </Text>
      )}
    </CardFrame>
  );
}
