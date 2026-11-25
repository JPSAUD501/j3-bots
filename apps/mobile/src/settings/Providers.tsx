// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import { connectCommand, installsHarnesses } from "@j3-bots/client-runtime/presentation";
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
import { ConnectCommand, ProviderRow } from "../components/Engine.tsx";
import { Problem, Quiet, Section, SkeletonRows, SwitchRow } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";

/**
 * Whether the engine runs, and if not, why and what to do; then each provider,
 * and, on a server that installs its own copies of the harnesses, whether it
 * keeps them up to date by itself. Disconnected, it is what the server last
 * reported, muted and said to be so.
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
  const connect = connectCommand(engine);
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
      {engine.providers.map((provider) => (
        <ProviderRow key={provider.id} provider={provider} stale={stale} version />
      ))}
      {installsHarnesses(engine) && <AutoUpdateHarnesses connected={connected} />}
      {!stale && connect !== null && <ConnectCommand command={connect} />}
    </Section>
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
