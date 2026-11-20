// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { useId, useState } from "react";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

interface NewBotDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves once the bot exists; the dialog then closes and its conversation opens. */
  readonly onCreate: (name: string, primary: boolean) => Promise<void>;
}

/** A name, and whether the bot becomes the primary one. The bot asks the rest itself. */
export function NewBotDialog({ open, onOpenChange, onCreate }: NewBotDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-labelledby={titleId}
          className="fixed inset-x-4 top-1/2 z-40 mx-auto flex max-w-sm -translate-y-1/2 flex-col gap-3 rounded-lg border border-border bg-surface p-5 text-foreground shadow-xl outline-none transition-[opacity,scale] duration-(--duration-slow) data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
        >
          <Dialog.Title id={titleId} className="text-lg font-medium">
            {t("newBot.title")}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            {t("newBot.body")}
          </Dialog.Description>
          {/* Mounted with the popup, so each opening starts empty. */}
          <NewBotForm onCreate={onCreate} onCancel={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NewBotForm({
  onCreate,
  onCancel,
}: {
  onCreate: NewBotDialogProps["onCreate"];
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const nameId = useId();
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState(false);
  const [state, setState] = useState<"editing" | "creating" | "failed">("editing");
  const trimmed = name.trim();
  const ready = trimmed !== "" && state !== "creating";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        setState("creating");
        onCreate(trimmed, primary).then(
          () => setState("editing"),
          () => setState("failed"),
        );
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
        className="h-9 rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11"
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
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>{t("newBot.cancel")}</Button>
        <Button type="submit" variant="primary" aria-disabled={!ready}>
          {t("firstRun.create.submit")}
        </Button>
      </div>
    </form>
  );
}
