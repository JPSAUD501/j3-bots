// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { useState } from "react";
import { View } from "react-native";
import { Problem, Quiet, Section } from "../components/form.tsx";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";

/**
 * The browser bots use keeps the operator's sign-ins; signing it out of every
 * site asks first, since it ends all of them at once, for every bot.
 */
export function BotBrowserSection({ connected }: { readonly connected: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const confirm = useConfirm();
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const signOut = () => {
    setState("pending");
    void client.signOutBrowser().then((result) => {
      if (result._tag === "done") say(t("settings.botBrowser.signOut.done"));
      setState(result._tag === "done" ? "idle" : "failed");
    });
  };
  return (
    <Section title={t("settings.botBrowser")}>
      <Quiet>{t("settings.botBrowser.hint")}</Quiet>
      <View className="items-start gap-1">
        <Button
          variant="destructive"
          label={t("settings.botBrowser.signOut")}
          disabled={!connected || state === "pending"}
          onPress={() =>
            confirm({
              title: t("settings.botBrowser.signOut.title"),
              body: t("settings.botBrowser.signOut.body"),
              cancel: t("settings.botBrowser.signOut.cancel"),
              confirm: t("settings.botBrowser.signOut.confirm"),
              onConfirm: signOut,
            })
          }
        />
        <Problem>{state === "failed" ? t("settings.botBrowser.signOut.failed") : null}</Problem>
      </View>
    </Section>
  );
}
