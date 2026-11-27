// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { SettingsSaves } from "@j3-bots/client-runtime";
import { sentAsJson, USAGE_DATA_DOCS, usageDataSwitch } from "@j3-bots/client-runtime/presentation";
import type { SentTelemetryEvent, Settings } from "@j3-bots/contracts";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { useI18n } from "../app/context";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import type { ShellIntents } from "../shell/data";
import { SwitchRow } from "./SettingsSwitch";
import { Button } from "./ui/button";
import { dialogBackdrop, screenDialog } from "./ui/dialog";
import { SkeletonRows } from "./ui/skeleton";

// The server's switch for anonymous usage data (decision 0099), on the About
// page: one sentence of what it is, where to read more, and the events the
// server sent, exactly as they left.

/** What was sent, as a read of it stands. */
export type SentRead =
  | { readonly _tag: "reading" }
  | { readonly _tag: "read"; readonly events: ReadonlyArray<SentTelemetryEvent> }
  | { readonly _tag: "failed" };

export function UsageDataSection({
  settings,
  save,
  connected,
  intents,
}: {
  settings: Settings | null;
  save: SettingsSaves["usage-data"];
  connected: boolean;
  intents: Pick<ShellIntents, "updateSettings" | "usageData">;
}) {
  const { t } = useI18n();
  const view = usageDataSwitch(settings, save);
  const [sent, setSent] = useState<SentRead | null>(null);
  if (view === null) return null;
  const readOnly = view.saving || view.heldOff || !connected;
  const read = () => {
    setSent({ _tag: "reading" });
    void intents.usageData
      .sent()
      .then((events) => setSent(events === null ? { _tag: "failed" } : { _tag: "read", events }));
  };
  return (
    <section className="flex flex-col gap-3">
      <h4 className="text-xs font-medium">{t("usageData.title")}</h4>
      <div className="flex flex-col gap-1">
        <SwitchRow
          label={t("usageData.switch")}
          hint={view.heldOff ? t("usageData.heldOff") : t("usageData.body")}
          checked={view.checked}
          readOnly={readOnly}
          onChange={(enabled) => {
            if (readOnly) return;
            intents.updateSettings({ section: "usage-data", changes: { enabled } });
          }}
        />
        <p role="status" className="text-xs text-blocked empty:sr-only">
          {view.failed && t("settings.saveFailed")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a
          href={USAGE_DATA_DOCS}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-xs underline underline-offset-2"
        >
          {t("usageData.learnMore")}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
        <Button size="sm" variant="ghost" onClick={read} disabled={!connected}>
          {t("usageData.seeSent")}
        </Button>
      </div>
      <SentDialog sent={sent} onRetry={read} onClose={() => setSent(null)} />
    </section>
  );
}

/** What "See what is sent" opens: the events the server sent, newest first, each as the JSON that left it. */
function SentDialog({
  sent,
  onRetry,
  onClose,
}: {
  sent: SentRead | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  // What it showed stays while it closes.
  const { held, closed } = useHeldWhileClosing(sent);
  return (
    <Dialog.Root
      open={sent !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) closed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-2xl`}
        >
          <SentPanel
            titleId={titleId}
            sent={held?.value ?? null}
            onRetry={onRetry}
            onClose={onClose}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The dialog's content, which the gallery shows in a frame of its own. */
export function SentPanel({
  titleId,
  sent,
  onRetry,
  onClose,
}: {
  titleId: string;
  sent: SentRead | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
        <h2 id={titleId} className="display-type truncate text-lg">
          {t("usageData.sent.title")}
        </h2>
        <Button
          variant="ghost-muted"
          size="icon"
          className="ms-auto"
          onClick={onClose}
          aria-label={t("usageData.sent.close")}
        >
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        <p className="text-sm text-muted-foreground">{t("usageData.sent.description")}</p>
        <SentList sent={sent} onRetry={onRetry} />
      </div>
    </div>
  );
}

function SentList({ sent, onRetry }: { sent: SentRead | null; onRetry: () => void }) {
  const { t } = useI18n();
  switch (sent?._tag) {
    case undefined:
      return null;
    case "reading":
      return <SkeletonRows count={3} />;
    case "failed":
      return (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-blocked">
            {t("usageData.sent.failed")}
          </p>
          <Button size="sm" onClick={onRetry}>
            {t("usageData.sent.retry")}
          </Button>
        </div>
      );
    case "read":
      return sent.events.length === 0 ? (
        <p className="text-sm">{t("usageData.sent.empty")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {sentAsJson(sent.events).map((json, index) => (
            <li key={sent.events[index]?.uuid ?? index}>
              <pre className="rounded-lg bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere">
                {json}
              </pre>
            </li>
          ))}
        </ol>
      );
  }
}
