// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { useId } from "react";
import { useI18n } from "../app/context";
import { NewBotForm } from "./NewBotForm";
import { alertDialog, dialogBackdrop, dialogTitle } from "./ui/dialog";

interface NewBotDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves once the bot exists; the dialog then closes and its conversation opens. */
  readonly onCreate: (name: string, primary: boolean) => Promise<void>;
  /** Whether a name is typed and not created yet. Held by the owner, which keeps such a form open. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
}

/** A name, and whether the bot becomes the primary one. The bot asks the rest itself. */
export function NewBotDialog({ open, onOpenChange, onCreate, onUnsavedChange }: NewBotDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup aria-labelledby={titleId} className={`${alertDialog} max-w-sm gap-3 p-5`}>
          <Dialog.Title id={titleId} className={dialogTitle}>
            {t("newBot.title")}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            {t("newBot.body")}
          </Dialog.Description>
          {/* Mounted with the popup, so each opening starts empty. */}
          <NewBotForm
            primaryAtFirst={false}
            onCreate={onCreate}
            onCancel={() => onOpenChange(false)}
            onUnsavedChange={onUnsavedChange}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
