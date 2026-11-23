// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AvatarChoice } from "@j3-bots/contracts";
import { freeAvatar } from "@j3-bots/design-tokens";
import { useEffect, useId, useState } from "react";
import { useBots, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { AvatarPicker } from "./avatar/AvatarPicker";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { lineField } from "./ui/field";

/** What the form creates: a name, whether the bot becomes the primary one, and its look. */
export interface NewBot {
  readonly name: string;
  readonly primary: boolean;
  readonly avatar: AvatarChoice;
}

interface NewBotFormProps {
  /** Whether "primary" starts checked: the first bot is the primary one unless the operator says otherwise. */
  readonly primaryAtFirst: boolean;
  /** Resolves once the bot exists. */
  readonly onCreate: (bot: NewBot) => Promise<void>;
  /** Absent where there is nothing to go back to. */
  readonly onCancel?: () => void;
  /** Told whether a name is typed and not created yet; told `false` again on unmount. */
  readonly onUnsavedChange?: (unsaved: boolean) => void;
  readonly className?: string;
}

/** Creating holds the look the bot is created with. */
type FormState =
  | { readonly _tag: "editing" }
  | { readonly _tag: "creating"; readonly avatar: AvatarChoice }
  | { readonly _tag: "failed" };

/**
 * A name, a look, and whether the bot becomes the primary one; the bot asks
 * the rest itself. The look starts as the one the server would give it, which
 * sits apart from the bots there are. Create stays focusable while it cannot act, and pressing it then
 * does nothing, as in pairing and the composer.
 */
export function NewBotForm({
  primaryAtFirst,
  onCreate,
  onCancel,
  onUnsavedChange,
  className,
}: NewBotFormProps) {
  const { t } = useI18n();
  const nameId = useId();
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState(primaryAtFirst);
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
  const unsaved = trimmed !== "";
  useEffect(() => {
    if (!unsaved || onUnsavedChange === undefined) return;
    onUnsavedChange(true);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);
  const submit = (
    <Button type="submit" variant="primary" aria-disabled={!ready}>
      {t("firstRun.create.submit")}
    </Button>
  );
  return (
    <form
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        setState({ _tag: "creating", avatar });
        // A created bot opens, which takes the form off the screen: until then it stays
        // creating, so Create cannot make a second bot.
        onCreate({ name: trimmed, primary, avatar }).catch(() => setState({ _tag: "failed" }));
      }}
    >
      <label htmlFor={nameId} className="sr-only">
        {t("firstRun.create.name")}
      </label>
      <input
        id={nameId}
        value={name}
        maxLength={40}
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder={t("firstRun.create.placeholder")}
        className={lineField}
      />
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
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state._tag === "failed" ? t("firstRun.create.failed") : null}
      </p>
      {onCancel === undefined ? (
        submit
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel}>{t("newBot.cancel")}</Button>
          {submit}
        </div>
      )}
    </form>
  );
}
