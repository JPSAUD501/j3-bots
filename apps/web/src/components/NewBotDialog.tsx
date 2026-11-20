// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { useId } from "react";
import { useI18n } from "../app/context";
import { NewBotForm } from "./NewBotForm";

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
          <NewBotForm
            primaryAtFirst={false}
            onCreate={onCreate}
            onCancel={() => onOpenChange(false)}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
