// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { MemoryDocument } from "@j3-bots/contracts";
import { XIcon } from "lucide-react";
import { useId } from "react";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";

/** A memory file as the viewer has it: still reading, read, or not readable. */
export type MemoryReading =
  | { readonly _tag: "reading" }
  | { readonly _tag: "read"; readonly document: MemoryDocument }
  | { readonly _tag: "failed" };

interface MemoryViewerProps {
  /** The file's name as the details list shows it. Null closes the viewer. */
  readonly title: string | null;
  readonly reading: MemoryReading;
  readonly onClose: () => void;
}

/** One memory file, read only, as the bot wrote it. */
export function MemoryViewer({ title, reading, onClose }: MemoryViewerProps) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <Dialog.Root
      open={title !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-labelledby={titleId}
          className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground outline-none transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0 tablet:inset-x-4 tablet:top-12 tablet:bottom-12 tablet:mx-auto tablet:max-w-2xl tablet:rounded-lg tablet:border tablet:border-border tablet:shadow-xl"
        >
          <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
            <Dialog.Title id={titleId} className="truncate text-sm font-medium">
              {title}
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button
                  variant="ghost-muted"
                  size="icon"
                  className="ms-auto"
                  aria-label={t("memory.close")}
                />
              }
            >
              <XIcon />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {reading._tag === "reading" && (
              <p className="text-xs text-muted-foreground">{t("details.loading")}</p>
            )}
            {reading._tag === "failed" && (
              <p role="alert" className="text-sm text-blocked">
                {t("memory.readFailed")}
              </p>
            )}
            {reading._tag === "read" && (
              <pre className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">
                {reading.document.text}
              </pre>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
