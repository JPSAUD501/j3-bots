// SPDX-License-Identifier: AGPL-3.0-or-later
import { providerLine, type ProviderTone } from "@j3-bots/client-runtime/wording";
import type { ProviderStatus } from "@j3-bots/contracts";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { usePresentation } from "../presentation.tsx";

const toneClass = {
  ready: "text-success",
  waiting: "text-waiting",
  blocked: "text-blocked",
  muted: "text-muted-foreground",
} as const satisfies Record<ProviderTone, string>;

/**
 * One provider: its name, and its state in words. `stale` mutes a state
 * reported before a disconnection.
 */
export function ProviderRow(props: {
  readonly provider: ProviderStatus;
  readonly stale?: boolean;
}) {
  const line = providerLine(props.provider, usePresentation());
  return (
    <View className="flex-row flex-wrap items-baseline justify-between gap-x-3 rounded-md border border-border px-3 py-2">
      <Text className="text-sm text-foreground">{props.provider.name}</Text>
      <Text
        className={`text-xs ${props.stale === true ? "text-muted-foreground" : toneClass[line.tone]}`}
      >
        {line.text}
      </Text>
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
