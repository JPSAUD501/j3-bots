// SPDX-License-Identifier: AGPL-3.0-or-later
import { EyeOffIcon } from "lucide-react";
import { useId } from "react";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

/** Whether a bot or room being created or changed goes among the hidden conversations. */
export function HideSwitch({
  checked,
  readOnly,
  onChange,
}: {
  readonly checked: boolean;
  /** While a save is under way the switch shows what it sends and takes no change. */
  readonly readOnly: boolean;
  readonly onChange: (hidden: boolean) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm">
          {t("visibility.hide")}
        </label>
        <span id={hintId} className="text-2xs text-muted-foreground">
          {t("visibility.hide.hint")}
        </span>
      </span>
      <Switch
        id={id}
        checked={checked}
        readOnly={readOnly}
        aria-describedby={hintId}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/**
 * In a hidden bot's or room's details: one quiet line saying it is out of
 * the list, and Show, which puts it back there and leaves the details open.
 */
export function HiddenNotice({
  name,
  onShow,
}: {
  /** The bot's or room's name, which Show is named for to screen readers. */
  readonly name: string;
  readonly onShow: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="appear flex items-center gap-2 ps-5 pe-3 pb-1 text-xs text-muted-foreground">
      <EyeOffIcon aria-hidden className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">{t("visibility.notice")}</p>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("roster.hidden.unhideName", { name })}
        onClick={onShow}
      >
        {t("roster.unhide")}
      </Button>
    </section>
  );
}
