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

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: string;
  readonly cancel: string;
  readonly confirm: string;
  readonly onConfirm: () => void;
  /** `destructive` for what cannot be undone; `primary` for a change the operator can make again. */
  readonly tone?: "destructive" | "primary";
}

/**
 * The question `Confirm` asks, opened by its owner rather than a trigger of
 * its own: from a menu row, which closes as the question opens.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  cancel,
  confirm,
  onConfirm,
  tone = "destructive",
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={cn(dialogBackdrop, "z-50")} />
        <AlertDialog.Popup className={cn(alertDialog, "z-50 max-w-sm gap-2 p-5")}>
          <AlertDialog.Title className={dialogTitle}>{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground">
            {body}
          </AlertDialog.Description>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button />}>{cancel}</AlertDialog.Close>
            <AlertDialog.Close
              render={<Button variant={tone === "destructive" ? "destructive" : "primary"} />}
              onClick={onConfirm}
            >
              {confirm}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
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
            <AlertDialog.Close render={<Button />}>{cancel}</AlertDialog.Close>
            <AlertDialog.Close render={<Button variant="destructive" />} onClick={onConfirm}>
              {confirm}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
