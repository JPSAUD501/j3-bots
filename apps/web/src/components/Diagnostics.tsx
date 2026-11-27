// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { useId, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import type { DiagnosticsIntents } from "../shell/data";
import { Button } from "./ui/button";
import { alertDialog, dialogBackdrop, dialogTitle } from "./ui/dialog";

/** Where the sheet stands: waiting for Save, getting the file from the server, or having failed to. */
export type DiagnosticsSheetState = "ready" | "preparing" | "failed";

/**
 * The About page's privacy area's row for the server's diagnostics zip: what
 * it is for, and Download diagnostics, which opens the sheet that says what
 * is in it before anything is saved.
 */
export function DiagnosticsRow({ diagnostics }: { diagnostics: DiagnosticsIntents }) {
  const { t } = useI18n();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiagnosticsSheetState>("ready");
  const close = () => {
    setOpen(false);
    setState("ready");
  };
  const save = () => {
    setState("preparing");
    void diagnostics.save().then((saved) => (saved ? close() : setState("failed")));
  };
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-2xs text-muted-foreground">{t("diagnostics.hint")}</p>
      <Dialog.Root
        open={open}
        // Getting the file is not called off: the sheet stays until it is saved or fails.
        onOpenChange={(next) => {
          if (state === "preparing") return;
          if (next) setOpen(true);
          else close();
        }}
      >
        <Dialog.Trigger render={<Button size="sm" />}>{t("diagnostics.download")}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className={cn(dialogBackdrop, "z-50")} />
          <Dialog.Popup aria-labelledby={titleId} className={cn(alertDialog, "z-50 max-w-sm p-5")}>
            <DiagnosticsSheet titleId={titleId} state={state} onSave={save} onCancel={close} />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function SheetList({ heading, items }: { heading: string; items: ReadonlyArray<string> }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium">{heading}</h3>
      <ul className="flex list-disc flex-col gap-0.5 ps-5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the sheet says, in its popup or in the gallery's frame: what the file
 * holds, what it never holds, and Save. Cancel waits while the file is made.
 */
export function DiagnosticsSheet({
  titleId,
  state,
  onSave,
  onCancel,
}: {
  titleId: string;
  state: DiagnosticsSheetState;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const preparing = state === "preparing";
  return (
    <div className="flex flex-col gap-3">
      <h2 id={titleId} className={dialogTitle}>
        {t("diagnostics.sheet.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("diagnostics.sheet.lead")}</p>
      <SheetList
        heading={t("diagnostics.sheet.inside")}
        items={[
          t("diagnostics.sheet.inside.logs"),
          t("diagnostics.sheet.inside.failures"),
          t("diagnostics.sheet.inside.setup"),
          t("diagnostics.sheet.inside.usageData"),
        ]}
      />
      <SheetList
        heading={t("diagnostics.sheet.never")}
        items={[
          t("diagnostics.sheet.never.messages"),
          t("diagnostics.sheet.never.names"),
          t("diagnostics.sheet.never.secrets"),
        ]}
      />
      {state === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          {t("diagnostics.sheet.failed")}
        </p>
      )}
      <div className="mt-1 flex flex-wrap justify-end gap-2">
        <Button disabled={preparing} onClick={onCancel}>
          {t("diagnostics.sheet.cancel")}
        </Button>
        <Button variant="primary" disabled={preparing} onClick={onSave}>
          {preparing ? t("diagnostics.sheet.preparing") : t("diagnostics.sheet.save")}
        </Button>
      </div>
    </div>
  );
}
