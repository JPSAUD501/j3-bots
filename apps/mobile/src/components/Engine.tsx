// SPDX-License-Identifier: AGPL-3.0-or-later
import { providerFix } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import {
  providerLine,
  type ProviderTone,
  providerVersionLine,
} from "@j3-bots/client-runtime/wording";
import type { ProviderStatus } from "@j3-bots/contracts";
import { useState } from "react";
import { Linking, View } from "react-native";
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
 * One provider: its name, its state in words, how the engine put it when it
 * gave its own words, and what fixes it (`ProviderFix`); with `version`, as
 * in Settings, also its harness's version and update (`ProviderUpdate`).
 * `stale` mutes a state reported before a disconnection, and leaves out the
 * rest, which may no longer hold.
 */
export function ProviderRow(props: {
  readonly provider: ProviderStatus;
  readonly stale?: boolean;
  readonly version?: boolean;
}) {
  const { t } = useI18n();
  // A phone never runs the server: its providers are always the server's.
  const line = providerLine(props.provider, usePresentation(), "server");
  const stale = props.stale === true;
  const { status } = props.provider;
  const detail = status._tag === "unavailable" ? status.detail : undefined;
  return (
    <View className="gap-1.5 rounded-md border border-border px-3 py-2">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3">
        <Text className="text-sm text-foreground">{props.provider.name}</Text>
        <Text className={`text-xs ${stale ? "text-muted-foreground" : toneClass[line.tone]}`}>
          {line.text}
        </Text>
      </View>
      {!stale && detail !== undefined && (
        <Text selectable className="text-xs text-muted-foreground">
          {t("provider.detail", { detail })}
        </Text>
      )}
      {!stale && <ProviderFix provider={props.provider} />}
      {!stale && props.version === true && <ProviderUpdate provider={props.provider} />}
    </View>
  );
}

/**
 * A provider's harness version and its update (`providerVersionLine`), under
 * its line: Update when the engine can install the newer version itself.
 * Nothing when the server reports no version.
 */
function ProviderUpdate(props: { readonly provider: ProviderStatus }) {
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

/**
 * What fixes a provider the engine cannot run (`providerFix`), under its
 * line: for a harness not installed on the server, where its maker says how
 * and a way to look again once it is; for one that failed, a way to try
 * again. Nothing for any other state.
 */
function ProviderFix(props: { readonly provider: ProviderStatus }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const [asking, setAsking] = useState<Asking>("idle");
  const fix = providerFix(props.provider);
  if (fix === null) return null;
  const { provider } = props;
  const recheck = () => {
    setAsking("asking");
    void client
      .recheckProvider(provider.id)
      .then((result) => setAsking(result._tag === "done" ? "idle" : "failed"));
  };
  const page = fix._tag === "install" ? fix.page : null;
  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap gap-2">
        {page !== null && (
          <Button
            variant="secondary"
            label={t("providers.notFound.install", { harness: provider.name })}
            onPress={() => void Linking.openURL(page)}
          />
        )}
        <Button
          variant={fix._tag === "retry" ? "secondary" : "quiet"}
          label={
            asking === "asking"
              ? t("provider.checking")
              : t(fix._tag === "retry" ? "provider.retry" : "providers.notFound.lookAgain")
          }
          held={asking === "asking"}
          onPress={recheck}
        />
      </View>
      {asking === "failed" && (
        <Text accessibilityRole="alert" className="text-xs text-blocked">
          {t("provider.recheckFailed")}
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
