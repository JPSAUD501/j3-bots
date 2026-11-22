// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { lineField } from "./ui/field";

interface NewBotFormProps {
  /** Whether "primary" starts checked: the first bot is the primary one unless the operator says otherwise. */
  readonly primaryAtFirst: boolean;
  /** Resolves once the bot exists. */
  readonly onCreate: (name: string, primary: boolean) => Promise<void>;
  /** Absent where there is nothing to go back to. */
  readonly onCancel?: () => void;
  /** Told whether a name is typed and not created yet; told `false` again on unmount. */
  readonly onUnsavedChange?: (unsaved: boolean) => void;
  readonly className?: string;
}

/**
 * A name, and whether the bot becomes the primary one; the bot asks the rest
 * itself. Create stays focusable while it cannot act, and pressing it then
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
  const [state, setState] = useState<"editing" | "creating" | "failed">("editing");
  const trimmed = name.trim();
  const ready = trimmed !== "" && state !== "creating";
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
        setState("creating");
        // A created bot opens, which takes the form off the screen: until then it stays
        // creating, so Create cannot make a second bot.
        onCreate(trimmed, primary).catch(() => setState("failed"));
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
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <span className="mt-px">
          <Checkbox checked={primary} onCheckedChange={setPrimary} />
        </span>
        <span>{t("firstRun.create.primary")}</span>
      </label>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state === "failed" ? t("firstRun.create.failed") : null}
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
