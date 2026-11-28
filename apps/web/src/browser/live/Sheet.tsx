// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../app/context";
import { Button } from "../../components/ui/button";
import { dialogBackdrop } from "../../components/ui/dialog";

/**
 * A sheet that rises from the bottom over the live view, as the phone's
 * do: its title, an optional lead beside it (the tab's faces), what it
 * holds, scrolling when long, and a footer that stays in sight under it.
 * A press outside it, Escape or its × closes it.
 */
export function Sheet({
  open,
  title,
  lead,
  footer,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-h-[85dvh] w-full max-w-xl flex-col rounded-t-sheet border border-b-0 border-border bg-surface pb-[env(safe-area-inset-bottom)] text-foreground shadow-overlay outline-none transition-transform duration-(--duration-slide) ease-slide data-ending-style:translate-y-full data-ending-style:duration-(--duration-state) data-ending-style:ease-out data-starting-style:translate-y-full">
          <div className="flex min-h-14 shrink-0 items-center gap-2 px-4 pt-2">
            {lead}
            <Dialog.Title className="min-w-0 flex-1 truncate text-base font-semibold">
              {title}
            </Dialog.Title>
            <Dialog.Close
              render={<Button variant="ghost-muted" size="icon" aria-label={t("browser.close")} />}
            >
              <XIcon />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
          {footer}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
