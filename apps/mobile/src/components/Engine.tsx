// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IntentResult } from "@j3-bots/client-runtime";
import { type OwnHarness, providerDetail, providerFix } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import {
  harnessOutcomeText,
  harnessTaskText,
  providerLine,
  type ProviderTone,
  providerVersionLine,
} from "@j3-bots/client-runtime/wording";
import type { ProviderStatus } from "@j3-bots/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { usePresentation } from "../presentation.tsx";

const toneClass = {
  ready: "text-success",
  waiting: "text-waiting",
  blocked: "text-blocked",
  muted: "text-muted-foreground",
} as const satisfies Record<ProviderTone, string>;

/**
 * A provider that is neither AI account, as the scripted agent of a
 * development server: its name, and its state in words. One the engine
 * cannot run also offers to check it again, and says what the engine said of
 * it. `stale` mutes a state reported before a disconnection, and leaves out
 * the rest, which may no longer hold.
 */
export function ProviderRow(props: {
  readonly provider: ProviderStatus;
  readonly stale?: boolean;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const [asking, ask] = useAsking();
  // A phone never runs the server: its providers are always the server's.
  const line = providerLine(props.provider, usePresentation(), "server");
  const stale = props.stale === true;
  const { provider } = props;
  const detail = providerDetail(provider);
  return (
    <View className="gap-1.5 rounded-md border border-border px-3 py-2">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3">
        <Text className="text-sm text-foreground">{provider.name}</Text>
        <Text className={`text-xs ${stale ? "text-muted-foreground" : toneClass[line.tone]}`}>
          {line.text}
        </Text>
      </View>
      {!stale && detail !== null && (
        <Text selectable className="text-xs text-muted-foreground">
          {detail}
        </Text>
      )}
      {!stale && providerFix(provider) !== null && (
        <View className="flex-row">
          <Button
            variant="secondary"
            label={t("ai.tryAgain")}
            held={asking === "asking"}
            onPress={() => ask(client.recheckProvider(provider.id))}
          />
        </View>
      )}
      {asking === "failed" && (
        <Text accessibilityRole="alert" className="text-xs text-blocked">
          {t("ai.requestFailed")}
        </Text>
      )}
    </View>
  );
}

/**
 * A provider's harness version and its update (`providerVersionLine`), under
 * its line: Update when the engine can install the newer version itself.
 * Nothing when the server reports no version.
 */
export function ProviderUpdate(props: { readonly provider: ProviderStatus }) {
  const { i18n } = usePresentation();
  const { t } = i18n;
  const client = useJ3Client();
  const [asking, setAsking] = useState<Asking>("idle");
  const line = providerVersionLine(props.provider, i18n);
  if (line === null) return null;
  const { provider } = props;
  const update = () => {
    setAsking("asking");
    void client
      .updateProvider(provider.id)
      .then((result) => setAsking(result._tag === "done" ? "idle" : "failed"));
  };
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{line.text}</Text>
      {line.detail !== null && (
        <Text selectable className="text-xs text-muted-foreground">
          {line.detail}
        </Text>
      )}
      {line.offer && (
        <View className="flex-row">
          <Button
            variant="secondary"
            label={asking === "asking" ? t("provider.updating") : t("provider.update")}
            held={asking === "asking"}
            onPress={update}
          />
        </View>
      )}
      {asking === "failed" && (
        <Text accessibilityRole="alert" className="text-xs text-blocked">
          {t("provider.updateRefused")}
        </Text>
      )}
    </View>
  );
}

type Asking = "idle" | "asking" | "failed";

/** A request to the server, and whether it took it, for a button to follow. */
const useAsking = () => {
  const [asking, setAsking] = useState<Asking>("idle");
  const ask = (request: Promise<IntentResult>) => {
    setAsking("asking");
    void request.then((result) => setAsking(result._tag === "done" ? "idle" : "failed"));
  };
  return [asking, ask] as const;
};

/**
 * The copy of its harness J3 Bots installed for a provider (`ownHarness`),
 * where `ProviderUpdate` shows the operator's own: the version it runs and
 * the newest, when that is newer, with Update; an update under way, with a
 * way to cancel it; and how the last install or update ended.
 */
export function OwnHarnessLine(props: { readonly own: OwnHarness }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const client = useJ3Client();
  const [asking, ask] = useAsking();
  const { own } = props;
  return (
    <View className="gap-1">
      {own.task === null ? (
        <>
          <Text className="text-xs text-muted-foreground tabular-nums">
            {own.newer === null
              ? t("provider.version", { installed: own.version })
              : t("provider.version.newer", { installed: own.version, latest: own.newer })}
          </Text>
          {own.last !== null && (
            <Text
              className={`text-xs ${own.last._tag === "failed" ? "text-blocked" : "text-muted-foreground"}`}
            >
              {harnessOutcomeText(own.last, ctx)}
            </Text>
          )}
          {own.newer !== null && (
            <View className="flex-row">
              <Button
                variant="secondary"
                label={t("provider.update")}
                held={asking === "asking"}
                onPress={() => ask(client.installHarness(own.harness))}
              />
            </View>
          )}
        </>
      ) : (
        <>
          <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
            {harnessTaskText(own.task, ctx.i18n)}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              variant="quiet"
              label={t("provider.install.cancel")}
              held={asking === "asking"}
              onPress={() => ask(client.cancelHarnessInstall(own.harness))}
            />
          </View>
        </>
      )}
      {asking === "failed" && (
        <Text accessibilityRole="alert" className="text-xs text-blocked">
          {t("provider.install.requestFailed")}
        </Text>
      )}
    </View>
  );
}

/**
 * The command that connects the providers, to run on the machine J3 Bots runs
 * on, not here: shown to read or select, wrapped to any width.
 */
export function ConnectCommand(props: { readonly command: string }) {
  return (
    <Text
      selectable
      face="mono"
      className="rounded-md bg-code-background px-2.5 py-1.5 text-xs text-foreground"
    >
      {props.command}
    </Text>
  );
}
