// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { Bot } from "@j3-bots/contracts";
import { useId } from "react";
import { useI18n } from "../app/context";
import { type NewBot, NewBotForm } from "./NewBotForm";
import { alertDialog, dialogBackdrop, dialogTitle } from "./ui/dialog";

interface NewBotDialogProps {
  /** Every bot there is: the form offers the look they use least. */
  readonly bots: ReadonlyArray<Bot>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves once the bot exists; the dialog then closes and its conversation opens. */
  readonly onCreate: (bot: NewBot) => Promise<void>;
  /** Whether a name is typed and not created yet. Held by the owner, which keeps such a form open. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
}

/** A name, a look, and whether the bot becomes the primary one. The bot asks the rest itself. */
export function NewBotDialog({
  bots,
  open,
  onOpenChange,
  onCreate,
  onUnsavedChange,
}: NewBotDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup aria-labelledby={titleId} className={`${alertDialog} max-w-md gap-3 p-5`}>
          <Dialog.Title id={titleId} className={dialogTitle}>
            {t("newBot.title")}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            {t("newBot.body")}
          </Dialog.Description>
          {/* Mounted with the popup, so each opening starts empty. */}
          <NewBotForm
            bots={bots}
            onCreate={onCreate}
            onCancel={() => onOpenChange(false)}
            onUnsavedChange={onUnsavedChange}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
