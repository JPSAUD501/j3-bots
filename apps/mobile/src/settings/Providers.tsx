// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HarnessSettingsChanges, SettingsSaves } from "@j3-bots/client-runtime";
import type { EngineStatus } from "@j3-bots/contracts";
import {
  type AiAccount,
  aiAccountProvider,
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
import { AiAccountList, useMobileAiConnect } from "../components/AiConnect.tsx";
import { OwnHarnessLine, ProviderRow, ProviderUpdate } from "../components/Engine.tsx";
import { Problem, Quiet, Section, SkeletonRows, SwitchRow } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";

/**
 * Whether J3 Bots can run bots, and if not, why and what to do; then each AI
 * account, with the same way to connect it as the first run, any other
 * provider, and, on a server that installs its own copies of the harnesses,
 * whether it keeps them up to date by itself; then whether the harnesses
 * suggest the operator's next message. Disconnected, it is what the
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
      {installsHarnesses(engine) && (
        <HarnessSwitch setting="autoUpdateHarnesses" connected={connected} />
      )}
      <HarnessSwitch setting="suggestReplies" connected={connected} />
    </Section>
  );
}

/**
 * Each AI account, one row each: where it stands with its one button beside
 * it, and once it is connected, the version it runs, with Update when a
 * newer one is out.
 */
function AiAccounts(props: { readonly engine: EngineStatus; readonly stale: boolean }) {
  const ai = useMobileAiConnect(props.engine);
  const version = (account: AiAccount) => {
    const provider = aiAccountProvider(props.engine, account);
    if (provider === undefined) return null;
    const own = ownHarness(provider);
    return own === null ? <ProviderUpdate provider={provider} /> : <OwnHarnessLine own={own} />;
  };
  return <AiAccountList ai={ai} stale={props.stale} extra={version} />;
}

/** The harness settings Providers offers as switches, and the words of each. */
const harnessSwitches = {
  autoUpdateHarnesses: {
    label: "settings.engine.autoUpdate",
    hint: "settings.engine.autoUpdate.body",
  },
  suggestReplies: {
    label: "settings.engine.suggestReplies",
    hint: "settings.engine.suggestReplies.body",
  },
} as const;

/**
 * One of what the harnesses do on their own: whether the server keeps its
 * own copies of Claude Code and Codex up to date, or whether they guess the
 * operator's next message. Saves at once, as the notification switches do;
 * a server that predates the setting shows nothing.
 */
function HarnessSwitch(props: {
  readonly setting: keyof HarnessSettingsChanges;
  readonly connected: boolean;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const settings = useSettings();
  const save: SettingsSaves["harnesses"] = useReadable(client.settingsSaves.harnesses);
  const saving = save._tag === "saving";
  // A save under way when Settings opened is followed by the switch it changes.
  const [watching, setWatching] = useState(saving && save.changes[props.setting] !== undefined);
  if (settings._tag !== "ready") return null;
  const current = settings.value[props.setting];
  if (current === null) return null;
  const readOnly = saving || !props.connected;
  const words = harnessSwitches[props.setting];
  return (
    <View className="gap-1">
      <SwitchRow
        label={t(words.label)}
        hint={t(words.hint)}
        value={(saving ? save.changes[props.setting] : undefined) ?? current}
        readOnly={readOnly}
        onChange={(on) => {
          if (readOnly) return;
          setWatching(true);
          void client.updateSettings({ section: "harnesses", changes: { [props.setting]: on } });
        }}
      />
      {/* Only under the switch whose save failed: the two share one save. */}
      <Problem>
        {watching && save._tag === "failed" && save.changes[props.setting] !== undefined
          ? t("settings.saveFailed")
          : null}
      </Problem>
    </View>
  );
}
