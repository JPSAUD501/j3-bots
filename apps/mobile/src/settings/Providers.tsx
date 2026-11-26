// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import type { EngineStatus } from "@j3-bots/contracts";
import {
  aiAccountProvider,
  aiAccounts,
  installsHarnesses,
  ownHarness,
} from "@j3-bots/client-runtime/presentation";
import {
  useConnection,
  useEngineStatus,
  useJ3Client,
  useReadable,
  useSettings,
} from "@j3-bots/client-runtime/react";
import { engineProblem } from "@j3-bots/client-runtime/wording";
import { useState } from "react";
import { View } from "react-native";
import { AiAccountCard, useMobileAiConnect } from "../components/AiConnect.tsx";
import { OwnHarnessLine, ProviderRow, ProviderUpdate } from "../components/Engine.tsx";
import { Problem, Quiet, Section, SkeletonRows, SwitchRow } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";

/**
 * Whether J3 Bots can run bots, and if not, why and what to do; then each AI
 * account, with the same way to connect it as the first run, any other
 * provider, and, on a server that installs its own copies of the harnesses,
 * whether it keeps them up to date by itself. Disconnected, it is what the
 * server last reported, muted and said to be so.
 */
export function ProvidersSection() {
  const i18n = useI18n();
  const { t } = i18n;
  const status = useEngineStatus();
  const connected = useConnection()._tag === "connected";
  if (status._tag !== "ready") {
    return (
      <Section open>
        <SkeletonRows />
      </Section>
    );
  }
  const { value: engine, stale } = status;
  const problem = engineProblem(engine, i18n);
  return (
    <Section open>
      {stale && <Quiet>{t("settings.engine.lastKnown")}</Quiet>}
      {problem === null ? (
        <Text className={`text-sm ${stale ? "text-muted-foreground" : "text-foreground"}`}>
          {t("settings.engine.ready", { version: engine.pinnedVersion })}
        </Text>
      ) : (
        <View className="gap-1">
          {/* Starting, or downloading, is on its way rather than blocked. */}
          <Text
            className={`text-sm font-medium tabular-nums ${
              stale
                ? "text-muted-foreground"
                : engine.state._tag === "starting"
                  ? "text-foreground"
                  : "text-blocked"
            }`}
          >
            {problem.title}
          </Text>
          <Quiet>{problem.body}</Quiet>
        </View>
      )}
      <AiAccounts engine={engine} stale={stale} />
      {engine.providers
        .filter((provider) => provider.harness === "other")
        .map((provider) => (
          <ProviderRow key={provider.id} provider={provider} stale={stale} />
        ))}
      {installsHarnesses(engine) && <AutoUpdateHarnesses connected={connected} />}
    </Section>
  );
}

/**
 * Each AI account, one card each: where it stands and its one button, then
 * the version it runs, with Update when a newer one is out.
 */
function AiAccounts(props: { readonly engine: EngineStatus; readonly stale: boolean }) {
  const ai = useMobileAiConnect(props.engine);
  return (
    <>
      {aiAccounts.map((account) => {
        const provider = aiAccountProvider(props.engine, account);
        const own = provider === undefined ? null : ownHarness(provider);
        return (
          <AiAccountCard key={account} ai={ai} account={account} stale={props.stale}>
            {provider !== undefined &&
              (own === null ? (
                <ProviderUpdate provider={provider} />
              ) : (
                <OwnHarnessLine own={own} />
              ))}
          </AiAccountCard>
        );
      })}
    </>
  );
}

/**
 * Whether the server keeps its own copies of Claude Code and Codex up to
 * date by itself. Saves at once, as the notification switches do.
 */
function AutoUpdateHarnesses(props: { readonly connected: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const settings = useSettings();
  const save: SettingsSaves["harnesses"] = useReadable(client.settingsSaves.harnesses);
  const saving = save._tag === "saving";
  const [watching, setWatching] = useState(saving);
  if (settings._tag !== "ready") return null;
  const readOnly = saving || !props.connected;
  return (
    <View className="gap-1">
      <SwitchRow
        label={t("settings.engine.autoUpdate")}
        hint={t("settings.engine.autoUpdate.body")}
        value={saving ? save.changes.autoUpdateHarnesses : settings.value.autoUpdateHarnesses}
        readOnly={readOnly}
        onChange={(autoUpdateHarnesses) => {
          if (readOnly) return;
          setWatching(true);
          void client.updateSettings({ section: "harnesses", changes: { autoUpdateHarnesses } });
        }}
      />
      <Problem>{watching && save._tag === "failed" ? t("settings.saveFailed") : null}</Problem>
    </View>
  );
}
