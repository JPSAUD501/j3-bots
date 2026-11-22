// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useState, type ReactElement, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { alertDialog, dialogBackdrop, dialogTitle } from "./dialog";

interface ConfirmProps {
  /** The button that opens the question, as an element to render the trigger with. */
  readonly trigger: ReactElement;
  /** The trigger's text. */
  readonly children: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly cancel: string;
  readonly confirm: string;
  readonly onConfirm: () => void;
  /** The confirmed action is under way: the trigger opens nothing until it ends. */
  readonly busy?: boolean;
}

/**
 * Asks before something that cannot be undone, naming what goes and what
 * stays. Cancel is where focus starts; the action runs only once confirmed.
 */
export function Confirm({
  trigger,
  children,
  title,
  body,
  cancel,
  confirm,
  onConfirm,
  busy = false,
}: ConfirmProps) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => setOpen(next && !busy)}>
      <AlertDialog.Trigger render={trigger}>{children}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={cn(dialogBackdrop, "z-50")} />
        <AlertDialog.Popup className={cn(alertDialog, "z-50 max-w-sm gap-2 p-5")}>
          <AlertDialog.Title className={dialogTitle}>{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground">
            {body}
          </AlertDialog.Description>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button variant="secondary" />}>{cancel}</AlertDialog.Close>
            <AlertDialog.Close render={<Button variant="destructive" />} onClick={onConfirm}>
              {confirm}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
