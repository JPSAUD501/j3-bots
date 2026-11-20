// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useState, type ReactElement, type ReactNode } from "react";
import { Button } from "./button";

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
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Popup className="fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-sm -translate-y-1/2 flex-col gap-2 rounded-lg border border-border bg-surface p-5 text-foreground shadow-xl outline-none transition-[opacity,scale] duration-(--duration-slow) data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <AlertDialog.Title className="text-lg font-medium">{title}</AlertDialog.Title>
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
