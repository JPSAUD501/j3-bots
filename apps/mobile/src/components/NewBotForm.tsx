// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { type AvatarChoice, type BotId, PROFILE_LIMITS } from "@j3-bots/contracts";
import { freeAvatar } from "@j3-bots/design-tokens";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../i18n.ts";
import { useBots } from "../presentation.tsx";
import { AvatarPicker } from "./avatar/AvatarPicker.tsx";
import { Button } from "../ui.tsx";
import { Problem, SwitchRow, TextField } from "./form.tsx";

/** Creating holds the look the bot is created with. */
type FormState =
  | { readonly _tag: "editing" }
  | { readonly _tag: "creating"; readonly avatar: AvatarChoice }
  | { readonly _tag: "failed" };

/**
 * A name, a look, and whether the bot becomes the primary one; the bot asks
 * the rest itself. The look starts as the one the server would give it, which
 * sits apart from the bots there are. `onCreated` gets the new bot once it exists.
 */
export function NewBotForm(props: {
  readonly onCreated: (botId: BotId) => void;
  /** Told whether a name is typed and not created yet. */
  readonly onNameChange?: (typed: boolean) => void;
  /** Before Create, as Cancel; absent where there is nothing to go back to. */
  readonly cancel?: ReactNode;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState(false);
  const bots = useBots();
  const [picked, setPicked] = useState<AvatarChoice | null>(null);
  const [state, setState] = useState<FormState>({ _tag: "editing" });
  // While the bot is created it joins the list, so the look it was created with stays on show.
  // Otherwise, until the operator picks one, the look follows the bots there are, which may
  // arrive after the form.
  const avatar =
    state._tag === "creating"
      ? state.avatar
      : (picked ?? freeAvatar([...bots.values()].map((bot) => bot.profile.avatar)));
  const trimmed = name.trim();
  const ready = trimmed !== "" && state._tag !== "creating";
  return (
    <View className="gap-4">
      <TextField
        label={t("firstRun.create.name")}
        value={name}
        placeholder={t("firstRun.create.placeholder")}
        maxLength={PROFILE_LIMITS.name}
        autoCapitalize="words"
        readOnly={state._tag === "creating"}
        onChange={(text) => {
          setName(text);
          props.onNameChange?.(text.trim() !== "");
        }}
      />
      <AvatarPicker
        value={avatar}
        onChange={setPicked}
        name={name}
        seed="new-bot"
        readOnly={state._tag === "creating"}
      />
      <SwitchRow
        label={t("firstRun.create.primary")}
        value={primary}
        readOnly={state._tag === "creating"}
        onChange={setPrimary}
      />
      <Problem>{state._tag === "failed" ? t("firstRun.create.failed") : null}</Problem>
      <View className="flex-row flex-wrap justify-end gap-2">
        {props.cancel}
        <Button
          variant="primary"
          label={t("firstRun.create.submit")}
          disabled={!ready}
          onPress={() => {
            if (!ready) return;
            setState({ _tag: "creating", avatar });
            void client.createBot({ name: trimmed, primary, avatar }).then((result) => {
              // A created bot opens, which takes the form off the screen: until then it stays
              // creating, so Create cannot make a second bot.
              if (result._tag === "done") {
                props.onCreated(result.value.id);
              } else {
                setState({ _tag: "failed" });
              }
            });
          }}
        />
      </View>
    </View>
  );
}
