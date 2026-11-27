// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { TemplateDraft } from "@j3-bots/client-runtime";
import {
  type TemplateRead,
  templateStart,
  templateSubmission,
} from "@j3-bots/client-runtime/presentation";
import {
  permissionModeText,
  templateReadText,
  templateTooLargeText,
} from "@j3-bots/client-runtime/wording";
import {
  type BotTemplate,
  type EngineStatus,
  type PermissionMode,
  PROFILE_LIMITS,
  type TemplateTooLarge,
} from "@j3-bots/contracts";
import { CopyIcon, CpuIcon, DownloadIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n } from "../app/context";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import { BackstageSwitch } from "./Visibility";
import { PermissionModeChoices } from "./PermissionModeChoices";
import { TemplatePreview } from "./TemplatePreview";
import { Button } from "./ui/button";
import { alertDialog, dialogBackdrop, dialogTitle, screenDialog } from "./ui/dialog";
import { lineField } from "./ui/field";

const sheetBody = "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4";
const sheetFooter = "flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3";

/** A sheet's title bar, with its close button. */
function SheetHeader({
  title,
  titleId,
  onClose,
}: {
  readonly title: string;
  readonly titleId: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
      <h2 id={titleId} className="display-type truncate text-lg">
        {title}
      </h2>
      <Button
        variant="ghost-muted"
        size="icon"
        className="ms-auto"
        onClick={onClose}
        aria-label={t("template.close")}
      >
        <XIcon />
      </Button>
    </header>
  );
}

/** A template's sheet: the whole screen on a phone, a panel over the app on wider ones. */
function Sheet({
  open,
  onClose,
  onClosed,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onClosed: () => void;
  /** Its content, given the id its title must carry. */
  readonly children: (titleId: string) => ReactNode;
}) {
  const titleId = useId();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-lg`}
        >
          {children(titleId)}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Sharing a bot as a template: its file is read from the server when the sheet opens. */
export type TemplateShare =
  | { readonly _tag: "loading"; readonly name: string }
  | { readonly _tag: "failed"; readonly name: string }
  /** Its file would be over the size any J3 Bots reads: trying again would not help. */
  | { readonly _tag: "too-large"; readonly name: string; readonly error: TemplateTooLarge }
  | { readonly _tag: "ready"; readonly template: BotTemplate };

interface ShareActions {
  readonly onRetry: () => void;
  readonly onDownload: (template: BotTemplate) => void;
  /** Resolves whether the text reached the clipboard. */
  readonly onCopy: (template: BotTemplate) => Promise<boolean>;
  readonly onClose: () => void;
}

/**
 * What the file will hold, in full, before it leaves: everything another
 * J3 Bots will read, and what stays here; then the file is downloaded or its
 * text copied. The sheet's content, whatever frames it.
 */
export function ShareTemplateContent({
  share,
  titleId,
  onRetry,
  onDownload,
  onCopy,
  onClose,
}: ShareActions & { readonly share: TemplateShare; readonly titleId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [copied, setCopied] = useState<boolean | null>(null);
  const name = share._tag === "ready" ? share.template.profile.name : share.name;
  return (
    <>
      <SheetHeader
        title={t("template.share.title", { name })}
        titleId={titleId}
        onClose={onClose}
      />
      <div className={sheetBody}>
        {share._tag === "loading" ? (
          <p className="text-sm text-muted-foreground">{t("template.share.loading")}</p>
        ) : share._tag === "failed" ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-blocked">
              {t("template.share.failed")}
            </p>
            <Button size="sm" onClick={onRetry}>
              {t("template.share.retry")}
            </Button>
          </div>
        ) : share._tag === "too-large" ? (
          <p role="alert" className="text-sm text-blocked">
            {templateTooLargeText(name, share.error, i18n)}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("template.share.body", { name })}</p>
            <TemplatePreview template={share.template} />
            <p className="border-t border-border pt-4 text-xs text-muted-foreground">
              {t("template.leftOut")}
            </p>
          </>
        )}
      </div>
      <footer className={sheetFooter}>
        <p role="status" className="text-xs text-muted-foreground empty:sr-only">
          {copied === null
            ? null
            : copied
              ? t("template.share.copied")
              : t("template.share.copyFailed")}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {share._tag === "ready" ? (
            <>
              <Button onClick={() => void onCopy(share.template).then(setCopied)}>
                <CopyIcon aria-hidden />
                {t("template.share.copy")}
              </Button>
              <Button variant="primary" onClick={() => onDownload(share.template)}>
                <DownloadIcon aria-hidden />
                {t("template.share.download")}
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>{t("template.close")}</Button>
          )}
        </div>
      </footer>
    </>
  );
}

/** `ShareTemplateContent` as a sheet over the app. */
export function ShareTemplateDialog({
  share,
  ...actions
}: ShareActions & {
  /** Null closes the sheet. */
  readonly share: TemplateShare | null;
}) {
  const { held, closed } = useHeldWhileClosing(share);
  return (
    <Sheet open={share !== null} onClose={actions.onClose} onClosed={closed}>
      {(titleId) =>
        held !== null && (
          // Mounted afresh with each opening, so nothing said about a copy carries over.
          <ShareTemplateContent
            key={held.opening}
            share={held.value}
            titleId={titleId}
            {...actions}
          />
        )
      }
    </Sheet>
  );
}

/** What creating the bot answered. */
export type TemplateCreated = "done" | "schedule" | "failed";

interface TemplateFormProps {
  readonly template: BotTemplate;
  readonly engine: EngineStatus | null;
  readonly connected: boolean;
  /** Resolves once the server answered; the owner closes the form on `done`. */
  readonly onCreate: (draft: TemplateDraft) => Promise<TemplateCreated>;
  readonly onClose: () => void;
}

/**
 * Creating a bot from a template, which is untrusted: the operator sees all
 * of it, the model it runs on here and the permission mode it starts with,
 * capped by the default unless they choose more, and whether it starts
 * behind the scenes; a template with no title asks for one, which Create
 * needs. Nothing is created until they press Create. The sheet's content,
 * whatever frames it.
 */
export function TemplateForm({
  template,
  engine,
  connected,
  onCreate,
  onClose,
  titleId,
}: TemplateFormProps & { readonly titleId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const modeId = useId();
  const start = templateStart(template, engine);
  const [picked, setPicked] = useState<PermissionMode | null>(null);
  const [hidden, setHidden] = useState(false);
  // Asked only of a template shared from a bot with no title.
  const asksTitle = template.profile.title === "";
  const [title, setTitle] = useState("");
  const titleFieldId = useId();
  const [state, setState] = useState<"editing" | "creating" | Exclude<TemplateCreated, "done">>(
    "editing",
  );
  const mode = picked ?? start.permissionMode;
  const { name } = template.profile;
  const creating = state === "creating";
  const picks = templateSubmission(template, start, picked, title);
  // A bot in the list says nothing of it, as the server's default.
  const submission = picks === null ? null : { ...picks, ...(hidden ? { hidden: true } : {}) };
  const ready = submission !== null && connected && !creating;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        setState("creating");
        void onCreate(submission).then((created) => {
          if (created !== "done") setState(created);
        });
      }}
    >
      <SheetHeader title={t("template.create.title")} titleId={titleId} onClose={onClose} />
      <div className={sheetBody}>
        <p className="text-sm text-muted-foreground">{t("template.create.body", { name })}</p>
        <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <ShieldAlertIcon aria-hidden className="mt-px size-4 shrink-0" />
          {t("template.create.untrusted")}
        </p>
        <TemplatePreview template={template} routinesNote={t("template.routines.paused", { name })}>
          {asksTitle && (
            <section className="flex flex-col gap-1 border-t border-border pt-4">
              <label htmlFor={titleFieldId} className="text-xs font-medium text-muted-foreground">
                {t("template.create.title.label", { name })}
              </label>
              <input
                id={titleFieldId}
                value={title}
                maxLength={PROFILE_LIMITS.title}
                readOnly={creating}
                autoComplete="off"
                placeholder={t("newBot.titleField.placeholder")}
                onChange={(event) => setTitle(event.currentTarget.value)}
                className={lineField}
              />
            </section>
          )}
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-xs font-medium text-muted-foreground">{t("template.model")}</h3>
            {start.model._tag === "none" ? (
              <p className="text-sm text-blocked">{t("template.create.noModel")}</p>
            ) : (
              <div className="flex items-start gap-2.5 text-sm">
                <CpuIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex flex-col">
                  <span>{start.model.name}</span>
                  {start.model._tag === "replaced" && (
                    <span className="text-xs text-muted-foreground">
                      {t("template.model.replaced", {
                        model: start.model.asked,
                        name,
                        replacement: start.model.name,
                      })}
                    </span>
                  )}
                </span>
              </div>
            )}
          </section>
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 id={modeId} className="text-xs font-medium text-muted-foreground">
              {t("template.permission")}
            </h3>
            {start.asked !== null && (
              <p className="text-xs text-muted-foreground">
                {t("template.permission.capped", {
                  mode: permissionModeText(start.asked, i18n).name,
                })}
              </p>
            )}
            <PermissionModeChoices
              value={mode}
              onChange={setPicked}
              readOnly={creating}
              labelledBy={modeId}
            />
          </section>
          <section className="border-t border-border pt-4">
            <BackstageSwitch checked={hidden} readOnly={creating} onChange={setHidden} />
          </section>
        </TemplatePreview>
      </div>
      <footer className={sheetFooter}>
        <p role="alert" className="text-xs text-blocked empty:sr-only">
          {state === "schedule"
            ? t("template.create.schedule")
            : state === "failed"
              ? t("template.create.failed")
              : null}
        </p>
        {!connected && (
          <p className="text-xs text-muted-foreground">{t("template.create.offline")}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t("template.create.cancel")}</Button>
          <Button type="submit" variant="primary" aria-disabled={!ready}>
            {creating ? t("template.create.creating") : t("template.create.submit", { name })}
          </Button>
        </div>
      </footer>
    </form>
  );
}

/**
 * A file opened to make a bot from: the template's form as a sheet, or, for
 * a file that is not a template this build can read, why not.
 */
export function NewFromTemplateDialog({
  opened,
  ...form
}: Omit<TemplateFormProps, "template"> & {
  /** Null closes the dialog. */
  readonly opened: TemplateRead | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { held, closed } = useHeldWhileClosing(opened);
  const shown = held?.value ?? null;
  if (shown !== null && shown._tag !== "template") {
    return (
      <Dialog.Root
        open={opened !== null}
        onOpenChange={(next) => {
          if (!next) form.onClose();
        }}
        onOpenChangeComplete={(next) => {
          if (!next) closed();
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className={dialogBackdrop} />
          <Dialog.Popup className={`${alertDialog} max-w-sm gap-3 p-5`}>
            <Dialog.Title className={dialogTitle}>{t("template.create.title")}</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              {templateReadText(shown, i18n)}
            </Dialog.Description>
            <div className="flex justify-end">
              <Button onClick={form.onClose}>{t("template.close")}</Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return (
    <Sheet open={opened !== null} onClose={form.onClose} onClosed={closed}>
      {(titleId) =>
        shown !== null &&
        held !== null && (
          // Mounted afresh with each opening, so each file starts from what it asks for.
          <TemplateForm key={held.opening} template={shown.template} titleId={titleId} {...form} />
        )
      }
    </Sheet>
  );
}
