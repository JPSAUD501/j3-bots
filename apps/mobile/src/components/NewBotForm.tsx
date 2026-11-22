// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { type BotId, PROFILE_LIMITS } from "@j3-bots/contracts";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../i18n.ts";
import { Button } from "../ui.tsx";
import { Problem, SwitchRow, TextField } from "./form.tsx";

/**
 * A name, and whether the bot becomes the primary one; the bot asks the rest
 * itself. `onCreated` gets the new bot once it exists.
 */
export function NewBotForm(props: {
  /** Whether "primary" starts on: the first bot is the primary one unless the operator says otherwise. */
  readonly primaryAtFirst: boolean;
  readonly onCreated: (botId: BotId) => void;
  /** Told whether a name is typed and not created yet. */
  readonly onNameChange?: (typed: boolean) => void;
  /** Before Create, as Cancel; absent where there is nothing to go back to. */
  readonly cancel?: ReactNode;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState(props.primaryAtFirst);
  const [state, setState] = useState<"editing" | "creating" | "failed">("editing");
  const trimmed = name.trim();
  const ready = trimmed !== "" && state !== "creating";
  return (
    <View className="gap-4">
      <TextField
        label={t("firstRun.create.name")}
        value={name}
        placeholder={t("firstRun.create.placeholder")}
        maxLength={PROFILE_LIMITS.name}
        autoCapitalize="words"
        readOnly={state === "creating"}
        onChange={(text) => {
          setName(text);
          props.onNameChange?.(text.trim() !== "");
        }}
      />
      <SwitchRow
        label={t("firstRun.create.primary")}
        value={primary}
        readOnly={state === "creating"}
        onChange={setPrimary}
      />
      <Problem>{state === "failed" ? t("firstRun.create.failed") : null}</Problem>
      <View className="flex-row flex-wrap justify-end gap-2">
        {props.cancel}
        <Button
          variant="primary"
          label={t("firstRun.create.submit")}
          disabled={!ready}
          onPress={() => {
            if (!ready) return;
            setState("creating");
            void client.createBot({ name: trimmed, primary }).then((result) => {
              if (result._tag === "done") {
                setState("editing");
                props.onCreated(result.value.id);
              } else {
                setState("failed");
              }
            });
          }}
        />
      </View>
    </View>
  );
}
