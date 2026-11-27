// SPDX-License-Identifier: AGPL-3.0-or-later
import { TheaterIcon } from "lucide-react";
import { useId } from "react";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

/** Whether a bot or room being created or changed goes behind the scenes, out of the list. */
export function BackstageSwitch({
  checked,
  readOnly,
  onChange,
}: {
  readonly checked: boolean;
  /** While a save is under way the switch shows what it sends and takes no change. */
  readonly readOnly: boolean;
  readonly onChange: (backstage: boolean) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm">
          {t("backstage.keep")}
        </label>
        <span id={hintId} className="text-2xs text-muted-foreground">
          {t("backstage.keep.hint")}
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
 * In the details of a bot or room behind the scenes: one quiet line saying it
 * is out of the list, and Bring back to the list, which leaves the details open.
 */
export function BackstageNotice({
  name,
  onBringBack,
}: {
  /** The bot's or room's name, which the button is named for to screen readers. */
  readonly name: string;
  readonly onBringBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="appear flex items-center gap-2 ps-5 pe-3 pb-1 text-xs text-muted-foreground">
      <TheaterIcon aria-hidden className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">{t("backstage.notice")}</p>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("backstage.bringBackName", { name })}
        onClick={onBringBack}
      >
        {t("backstage.bringBack")}
      </Button>
    </section>
  );
}
