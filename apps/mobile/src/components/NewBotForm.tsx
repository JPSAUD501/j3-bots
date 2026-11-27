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
 * A name, a title, a look, whether the bot becomes the primary one, and
 * whether it stays behind the scenes; the bot asks the rest itself. The name
 * makes it a person and the title says what it is for, so Create needs both;
 * pressed with a name and no title, it says the title is missing. The look
 * starts as the one the server would give it, which sits apart from the bots
 * there are. `onCreated` gets the new bot once it exists.
 */
export function NewBotForm(props: {
  readonly onCreated: (botId: BotId) => void;
  /** Told whether a name or a title is typed and not created yet. */
  readonly onTypedChange?: (typed: boolean) => void;
  /** Before Create, as Cancel; absent where there is nothing to go back to. */
  readonly cancel?: ReactNode;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  // Said once Create was pressed without a title, until one is typed.
  const [titleMissing, setTitleMissing] = useState(false);
  const [primary, setPrimary] = useState(false);
  const [hidden, setHidden] = useState(false);
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
  const trimmedTitle = title.trim();
  const ready = trimmed !== "" && trimmedTitle !== "" && state._tag !== "creating";
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
          props.onTypedChange?.(text.trim() !== "" || trimmedTitle !== "");
        }}
      />
      <TextField
        label={t("newBot.titleField")}
        value={title}
        placeholder={t("newBot.titleField.placeholder")}
        maxLength={PROFILE_LIMITS.title}
        readOnly={state._tag === "creating"}
        error={titleMissing ? t("editBot.title.required") : null}
        onChange={(text) => {
          setTitle(text);
          setTitleMissing(false);
          props.onTypedChange?.(trimmed !== "" || text.trim() !== "");
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
      <SwitchRow
        label={t("backstage.keep")}
        hint={t("backstage.keep.hint")}
        value={hidden}
        readOnly={state._tag === "creating"}
        onChange={setHidden}
      />
      <Problem>{state._tag === "failed" ? t("firstRun.create.failed") : null}</Problem>
      <View className="flex-row flex-wrap justify-end gap-2">
        {props.cancel}
        <Button
          variant="primary"
          label={t("firstRun.create.submit")}
          disabled={trimmed === "" || state._tag === "creating"}
          onPress={() => {
            if (trimmedTitle === "") setTitleMissing(true);
            if (!ready) return;
            setState({ _tag: "creating", avatar });
            const draft = {
              name: trimmed,
              title: trimmedTitle,
              primary,
              avatar,
              ...(hidden ? { hidden } : {}),
            };
            void client.createBot(draft).then((result) => {
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
