// SPDX-License-Identifier: AGPL-3.0-or-later
import { type AvatarChoice, type Bot, PROFILE_LIMITS } from "@j3-bots/contracts";
import { freeAvatar } from "@j3-bots/design-tokens";
import { useEffect, useId, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { AvatarPicker } from "./avatar/AvatarPicker";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { lineField } from "./ui/field";

/**
 * What the form creates: a name and a title, whether the bot becomes the
 * primary one or stays behind the scenes, and its look.
 */
export interface NewBot {
  readonly name: string;
  readonly title: string;
  readonly primary: boolean;
  readonly hidden: boolean;
  readonly avatar: AvatarChoice;
}

interface NewBotFormProps {
  /** Every bot there is, those behind the scenes included, so the look offered first is the one they use least. */
  readonly bots: ReadonlyArray<Bot>;
  /** Resolves once the bot exists. */
  readonly onCreate: (bot: NewBot) => Promise<void>;
  readonly onCancel: () => void;
  /** Told whether a name or a title is typed and not created yet; told `false` again on unmount. */
  readonly onUnsavedChange?: (unsaved: boolean) => void;
  readonly className?: string;
}

/** Creating holds the look the bot is created with. */
type FormState =
  | { readonly _tag: "editing" }
  | { readonly _tag: "creating"; readonly avatar: AvatarChoice }
  | { readonly _tag: "failed" };

/**
 * A name, a title, a look, whether the bot becomes the primary one and
 * whether it stays behind the scenes; the bot asks the rest itself. The name
 * makes it a person and the title says what it is for, so Create needs both.
 * The look starts as the one the server would give it, which sits apart from
 * the bots there are. Create stays focusable while it cannot act, and
 * pressing it then does nothing, as in pairing and the composer; pressed
 * with a name and no title, it says the title is missing.
 */
export function NewBotForm({
  bots,
  onCreate,
  onCancel,
  onUnsavedChange,
  className,
}: NewBotFormProps) {
  const { t } = useI18n();
  const nameId = useId();
  const titleId = useId();
  const titleErrorId = useId();
  const hideHintId = useId();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  // Said once Create was pressed without a title, until one is typed.
  const [titleMissing, setTitleMissing] = useState(false);
  const [primary, setPrimary] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [picked, setPicked] = useState<AvatarChoice | null>(null);
  const [state, setState] = useState<FormState>({ _tag: "editing" });
  // While the bot is created it joins the list, so the look it was created with stays on show.
  // Otherwise, until the operator picks one, the look follows the bots there are, which may
  // arrive after the form.
  const avatar =
    state._tag === "creating"
      ? state.avatar
      : (picked ?? freeAvatar(bots.map((bot) => bot.profile.avatar)));
  const trimmed = name.trim();
  const trimmedTitle = title.trim();
  // With a name, Create acts: it creates, or says the title is missing.
  const pressable = trimmed !== "" && state._tag !== "creating";
  const ready = pressable && trimmedTitle !== "";
  const unsaved = trimmed !== "" || trimmedTitle !== "";
  useEffect(() => {
    if (!unsaved || onUnsavedChange === undefined) return;
    onUnsavedChange(true);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);
  return (
    <form
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (pressable && trimmedTitle === "") setTitleMissing(true);
        if (!ready) return;
        setState({ _tag: "creating", avatar });
        // A created bot opens, which takes the form off the screen: until then it stays
        // creating, so Create cannot make a second bot.
        onCreate({ name: trimmed, title: trimmedTitle, primary, hidden, avatar }).catch(() =>
          setState({ _tag: "failed" }),
        );
      }}
    >
      <label htmlFor={nameId} className="sr-only">
        {t("firstRun.create.name")}
      </label>
      <input
        id={nameId}
        value={name}
        maxLength={PROFILE_LIMITS.name}
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder={t("firstRun.create.placeholder")}
        className={lineField}
      />
      <label htmlFor={titleId} className="sr-only">
        {t("newBot.titleField")}
      </label>
      <input
        id={titleId}
        value={title}
        maxLength={PROFILE_LIMITS.title}
        autoComplete="off"
        onChange={(event) => {
          setTitle(event.currentTarget.value);
          setTitleMissing(false);
        }}
        placeholder={t("newBot.titleField.placeholder")}
        className={lineField}
        {...(titleMissing ? { "aria-invalid": true, "aria-describedby": titleErrorId } : {})}
      />
      {titleMissing && (
        <p id={titleErrorId} className="text-xs text-blocked">
          {t("editBot.title.required")}
        </p>
      )}
      <AvatarPicker
        value={avatar}
        onChange={setPicked}
        name={name}
        seed="new-bot"
        readOnly={state._tag === "creating"}
      />
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <span className="mt-px">
          <Checkbox checked={primary} onCheckedChange={setPrimary} />
        </span>
        <span>{t("firstRun.create.primary")}</span>
      </label>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <span className="mt-px">
          <Checkbox
            checked={hidden}
            readOnly={state._tag === "creating"}
            onCheckedChange={setHidden}
            aria-describedby={hideHintId}
          />
        </span>
        <span className="flex flex-col gap-0.5">
          <span>{t("backstage.keep")}</span>
          <span id={hideHintId} className="text-2xs">
            {t("backstage.keep.hint")}
          </span>
        </span>
      </label>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state._tag === "failed" ? t("firstRun.create.failed") : null}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>{t("newBot.cancel")}</Button>
        <Button type="submit" variant="primary" aria-disabled={!pressable}>
          {t("firstRun.create.submit")}
        </Button>
      </div>
    </form>
  );
}
